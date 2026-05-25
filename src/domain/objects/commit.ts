/**
 * Commit serializer. Produces the canonical Git commit-object payload
 * (`tree <sha>\nparent <sha>*\nauthor …\ncommitter …\n\n<message>`) that
 * sits inside a loose commit object. SHA equality is the contract;
 * disk-bytes vary by zlib compression level (loose object caveat).
 *
 * @writes
 *   surface: commit
 *   kind:    equivalent-under-readback
 *   format:  git-commit-object
 */
import type { AuthorIdentity } from './author-identity.js';
import { parseIdentity, serializeIdentity } from './author-identity.js';
import {
  decode,
  encode,
  formatContinuationHeader,
  parseOptionalHeaderBlock,
  splitHeaderAndMessage,
} from './encoding.js';
import { invalidCommit } from './error.js';
import type { ObjectId } from './object-id.js';
import { ObjectId as ObjectIdFactory } from './object-id.js';

export interface ExtraHeader {
  readonly key: string;
  readonly value: string;
}

export interface CommitData {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders: ReadonlyArray<ExtraHeader>;
}

export interface Commit {
  readonly type: 'commit';
  readonly id: ObjectId;
  readonly data: CommitData;
}

export function parseCommitContent(id: ObjectId, content: Uint8Array): Commit {
  const { headerPart, message } = splitHeaderAndMessage(decode(content));
  const lines = headerPart.split('\n');
  const { tree, parents, author, committer, nextIndex } = parseRequiredFields(lines);
  const { gpgSignature, extraHeaders } = parseOptionalHeaders(lines, nextIndex);

  return {
    type: 'commit',
    id,
    data: {
      tree,
      parents,
      author,
      committer,
      message,
      ...(gpgSignature !== undefined ? { gpgSignature } : {}),
      extraHeaders,
    },
  };
}

function parseRequiredFields(lines: ReadonlyArray<string>): {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly nextIndex: number;
} {
  if (!lines[0]!.startsWith('tree ')) {
    throw invalidCommit('first line must be tree');
  }
  const tree = ObjectIdFactory.from(lines[0]!.slice(5));

  const parents: ObjectId[] = [];
  let i = 1;
  while (i < lines.length && lines[i]!.startsWith('parent ')) {
    parents.push(ObjectIdFactory.from(lines[i]!.slice(7)));
    i++;
  }

  if (i >= lines.length || !lines[i]!.startsWith('author ')) {
    throw invalidCommit('missing author');
  }
  const author = parseIdentity(lines[i]!.slice(7));
  i++;

  if (i >= lines.length || !lines[i]!.startsWith('committer ')) {
    throw invalidCommit('missing committer');
  }
  const committer = parseIdentity(lines[i]!.slice(10));
  i++;

  return { tree, parents, author, committer, nextIndex: i };
}

function parseOptionalHeaders(
  lines: ReadonlyArray<string>,
  startIndex: number,
): {
  readonly gpgSignature: string | undefined;
  readonly extraHeaders: ReadonlyArray<ExtraHeader>;
} {
  return parseOptionalHeaderBlock(
    lines,
    startIndex,
    (msg) => {
      throw invalidCommit(msg);
    },
    (msg) => {
      throw invalidCommit(msg);
    },
  );
}

export function serializeCommitContent(commit: Commit): Uint8Array {
  const lines: string[] = [];
  const { data } = commit;

  lines.push(`tree ${data.tree}`);
  for (const parent of data.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${serializeIdentity(data.author)}`);
  lines.push(`committer ${serializeIdentity(data.committer)}`);

  if (data.gpgSignature !== undefined) {
    lines.push(formatContinuationHeader('gpgsig', data.gpgSignature));
  }

  for (const header of data.extraHeaders) {
    lines.push(formatContinuationHeader(header.key, header.value));
  }

  const headerText = lines.join('\n');
  return encode(`${headerText}\n\n${data.message}`);
}
