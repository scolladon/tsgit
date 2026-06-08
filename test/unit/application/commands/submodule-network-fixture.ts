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
