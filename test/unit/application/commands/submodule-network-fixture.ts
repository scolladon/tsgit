/**
 * Synthetic submodule remote for the `add`/`update` unit tests. Builds a pack
 * carrying a single-commit history per branch (commit → tree → blob) and an
 * `HttpTransport` that serves it for a child-context `clone`. No real network:
 * the same memory adapter the test drives also seeds the pack.
 */

import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import { serializeObject } from '../../../../src/domain/objects/git-object.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
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
import { buildSyntheticPack, type EntrySpec } from '../primitives/pack-fixture.js';

const ENCODER = new TextEncoder();

export const REMOTE_IDENTITY = {
  name: 'Sub Author',
  email: 'sub@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

/** A branch served by the remote: one root commit pinning `<file>` to `<content>`. */
export interface RemoteBranchSpec {
  readonly name: string;
  readonly file: string;
  readonly content: string;
}

export interface SubmoduleRemote {
  readonly transport: HttpTransport;
  /** Commit oid per branch name. */
  readonly commits: ReadonlyMap<string, ObjectId>;
}

const stripHeader = (bytes: Uint8Array): Uint8Array => bytes.subarray(bytes.indexOf(0) + 1);

/** Build the static transport that answers discovery + upload-pack with `pack`. */
const makeTransport = (
  refs: ReadonlyArray<{ readonly name: string; readonly id: string }>,
  capabilities: ReadonlyArray<string>,
  pack: Uint8Array,
): HttpTransport => {
  const discoveryBody = buildDiscoveryBody({ service: 'git-upload-pack', capabilities, refs });
  const packResponseBody = buildUploadPackResponseBody({ packBytes: pack, sideBand: true });
  return {
    request: async (req: HttpRequest): Promise<HttpResponse> => {
      const body = req.url.includes('/info/refs') ? discoveryBody : packResponseBody;
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice());
            controller.close();
          },
        }),
      };
    },
  };
};

/**
 * Build a submodule remote serving one root commit per branch. `head` selects
 * the `symref=HEAD:` branch (the one a default `add` checks out). Branch
 * `content` values must be distinct so no two blobs collide in the pack.
 */
export const buildSubmoduleRemote = async (
  ctx: Context,
  opts: { readonly branches: ReadonlyArray<RemoteBranchSpec>; readonly head: string },
): Promise<SubmoduleRemote> => {
  const entries: EntrySpec[] = [];
  const commits = new Map<string, ObjectId>();
  const refs: Array<{ readonly name: string; readonly id: ObjectId }> = [];
  for (const branch of opts.branches) {
    const blobBytes = serializeObject(
      { type: 'blob', id: '' as ObjectId, content: ENCODER.encode(branch.content) },
      ctx.hashConfig,
    );
    const blobId = (await ctx.hash.hashHex(blobBytes)) as ObjectId;
    const treeBytes = serializeObject(
      {
        type: 'tree',
        id: '' as ObjectId,
        entries: [{ mode: FILE_MODE.REGULAR, name: branch.file, id: blobId }],
      },
      ctx.hashConfig,
    );
    const treeId = (await ctx.hash.hashHex(treeBytes)) as ObjectId;
    const commitBytes = serializeObject(
      {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: treeId,
          parents: [],
          author: REMOTE_IDENTITY,
          committer: REMOTE_IDENTITY,
          message: branch.name,
          extraHeaders: [],
        },
      },
      ctx.hashConfig,
    );
    const commitId = (await ctx.hash.hashHex(commitBytes)) as ObjectId;
    entries.push(
      { kind: 'base', type: 'blob', content: stripHeader(blobBytes) },
      { kind: 'base', type: 'tree', content: stripHeader(treeBytes) },
      { kind: 'base', type: 'commit', content: stripHeader(commitBytes) },
    );
    commits.set(branch.name, commitId);
    refs.push({ name: `refs/heads/${branch.name}`, id: commitId });
  }
  const { packBytes } = await buildSyntheticPack(ctx, entries);
  const capabilities = ['side-band-64k', 'ofs-delta', `symref=HEAD:refs/heads/${opts.head}`];
  return { transport: makeTransport(refs, capabilities, packBytes), commits };
};

interface TreeEntrySpec {
  readonly mode: typeof FILE_MODE.REGULAR;
  readonly name: string;
  readonly id: ObjectId;
}

/** Accumulate unique objects (deduped by id) for a multi-commit pack. */
const createPackBuilder = (ctx: Context) => {
  const byId = new Map<string, EntrySpec>();
  const add = async (object: Parameters<typeof serializeObject>[0]): Promise<ObjectId> => {
    const bytes = serializeObject(object, ctx.hashConfig);
    const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
    if (!byId.has(id))
      byId.set(id, { kind: 'base', type: object.type, content: stripHeader(bytes) });
    return id;
  };
  return {
    blob: (content: string): Promise<ObjectId> =>
      add({ type: 'blob', id: '' as ObjectId, content: ENCODER.encode(content) }),
    tree: (entries: ReadonlyArray<TreeEntrySpec>): Promise<ObjectId> =>
      add({ type: 'tree', id: '' as ObjectId, entries: [...entries] }),
    commit: (
      tree: ObjectId,
      parents: ReadonlyArray<ObjectId>,
      message: string,
    ): Promise<ObjectId> =>
      add({
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree,
          parents: [...parents],
          author: REMOTE_IDENTITY,
          committer: REMOTE_IDENTITY,
          message,
          extraHeaders: [],
        },
      }),
    pack: async (): Promise<Uint8Array> =>
      (await buildSyntheticPack(ctx, [...byId.values()])).packBytes,
  };
};

export interface DivergentRemote {
  readonly transport: HttpTransport;
  /** Shared base commit. */
  readonly base: ObjectId;
  /** `main` tip — base + a change to `f.txt` and a new `a.txt`. */
  readonly m1: ObjectId;
  /** `other` tip — base + a new `m.txt` (touches different paths than m1). */
  readonly m2: ObjectId;
}

/**
 * A remote whose `main` (→ m1) and `other` (→ m2) branches diverge from a shared
 * base, touching disjoint paths so a rebase/merge of one onto the other never
 * conflicts. `head` is `main`. Drives the `update --rebase`/`--merge` tests:
 * the module clones onto `main` (m1), and reconciling to a pin of `m2` exercises
 * a real (linear vs merge-commit) reconciliation.
 */
export const buildDivergentRemote = async (ctx: Context): Promise<DivergentRemote> => {
  const b = createPackBuilder(ctx);
  const REGULAR = FILE_MODE.REGULAR;
  const baseF = await b.blob('base\n');
  const base = await b.commit(
    await b.tree([{ mode: REGULAR, name: 'f.txt', id: baseF }]),
    [],
    'base',
  );
  const mainF = await b.blob('main change\n');
  const aBlob = await b.blob('a only\n');
  const m1 = await b.commit(
    await b.tree([
      { mode: REGULAR, name: 'a.txt', id: aBlob },
      { mode: REGULAR, name: 'f.txt', id: mainF },
    ]),
    [base],
    'm1',
  );
  const mBlob = await b.blob('m only\n');
  const m2 = await b.commit(
    await b.tree([
      { mode: REGULAR, name: 'f.txt', id: baseF },
      { mode: REGULAR, name: 'm.txt', id: mBlob },
    ]),
    [base],
    'm2',
  );
  const refs = [
    { name: 'refs/heads/main', id: m1 },
    { name: 'refs/heads/other', id: m2 },
  ];
  const capabilities = ['side-band-64k', 'ofs-delta', 'symref=HEAD:refs/heads/main'];
  return { transport: makeTransport(refs, capabilities, await b.pack()), base, m1, m2 };
};
