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
  decodePreservingBom,
  encode,
  formatContinuationHeader,
  indexOf,
  parseOptionalHeaderBlock,
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

const NEWLINE = 0x0a;

const TREE_PREFIX = 'tree ';
const PARENT_PREFIX = 'parent ';
const AUTHOR_PREFIX = 'author ';
const COMMITTER_PREFIX = 'committer ';

/** A `[start, end)` byte offset pair into a parent buffer — never copied. */
type LineRange = readonly [start: number, end: number];

// Byte-level equivalent of `text.indexOf('\n\n')`: the header/message
// separator is found by scanning raw bytes, so a large message body is
// never decoded just to locate where the headers end.
function findBlankLine(content: Uint8Array): number {
  let from = 0;
  for (;;) {
    const newline = indexOf(content, NEWLINE, from);
    if (newline === -1) return -1;
    if (content[newline + 1] === NEWLINE) return newline;
    from = newline + 1;
  }
}

// Byte-level equivalent of `text.split('\n')`, returning offset pairs
// instead of allocating one string per line up front — a line is decoded
// only once its content is actually needed.
function splitByteLines(bytes: Uint8Array): LineRange[] {
  const lines: LineRange[] = [];
  let start = 0;
  for (;;) {
    const newline = indexOf(bytes, NEWLINE, start);
    if (newline === -1) {
      lines.push([start, bytes.length]);
      return lines;
    }
    lines.push([start, newline]);
    start = newline + 1;
  }
}

// ASCII prefix comparison directly on bytes — no decode, no allocation —
// for the fixed header keywords every commit line is tested against.
function lineStartsWithAscii(bytes: Uint8Array, [start, end]: LineRange, prefix: string): boolean {
  if (end - start < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[start + i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

// Decodes a line's value (the range past its `skip`-byte keyword prefix)
// on demand — the one decode a required field's hot path actually needs.
function decodeLineValue(bytes: Uint8Array, [start, end]: LineRange, skip: number): string {
  return decodePreservingBom(bytes.subarray(start + skip, end));
}

export function parseCommitContent(id: ObjectId, content: Uint8Array): Commit {
  const blankLineStart = findBlankLine(content);
  const headerBytes = blankLineStart === -1 ? content : content.subarray(0, blankLineStart);
  const message =
    blankLineStart === -1 ? '' : decodePreservingBom(content.subarray(blankLineStart + 2));
  const lines = splitByteLines(headerBytes);
  const { tree, parents, author, committer, nextIndex } = parseRequiredFields(headerBytes, lines);
  const { gpgSignature, extraHeaders } = parseOptionalHeaders(headerBytes, lines, nextIndex);

  const data: CommitData = Object.freeze({
    tree,
    parents: Object.freeze(parents),
    author,
    committer,
    message,
    ...(gpgSignature !== undefined ? { gpgSignature } : {}),
    extraHeaders: Object.freeze(extraHeaders),
  });

  return { type: 'commit', id, data };
}

function parseRequiredFields(
  bytes: Uint8Array,
  lines: ReadonlyArray<LineRange>,
): {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly nextIndex: number;
} {
  if (!lineStartsWithAscii(bytes, lines[0]!, TREE_PREFIX)) {
    throw invalidCommit('first line must be tree');
  }
  const tree = ObjectIdFactory.from(decodeLineValue(bytes, lines[0]!, TREE_PREFIX.length));

  const parents: ObjectId[] = [];
  let i = 1;
  while (i < lines.length && lineStartsWithAscii(bytes, lines[i]!, PARENT_PREFIX)) {
    parents.push(ObjectIdFactory.from(decodeLineValue(bytes, lines[i]!, PARENT_PREFIX.length)));
    i++;
  }

  if (i >= lines.length || !lineStartsWithAscii(bytes, lines[i]!, AUTHOR_PREFIX)) {
    throw invalidCommit('missing author');
  }
  const author = parseIdentity(decodeLineValue(bytes, lines[i]!, AUTHOR_PREFIX.length));
  i++;

  if (i >= lines.length || !lineStartsWithAscii(bytes, lines[i]!, COMMITTER_PREFIX)) {
    throw invalidCommit('missing committer');
  }
  const committer = parseIdentity(decodeLineValue(bytes, lines[i]!, COMMITTER_PREFIX.length));
  i++;

  return { tree, parents, author, committer, nextIndex: i };
}

function parseOptionalHeaders(
  bytes: Uint8Array,
  lines: ReadonlyArray<LineRange>,
  startIndex: number,
): {
  readonly gpgSignature: string | undefined;
  readonly extraHeaders: ReadonlyArray<ExtraHeader>;
} {
  const remainingLines = lines
    .slice(startIndex)
    .map(([start, end]) => decodePreservingBom(bytes.subarray(start, end)));
  return parseOptionalHeaderBlock(
    remainingLines,
    0,
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
