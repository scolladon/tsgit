/**
 * Tag serializer. Produces the canonical annotated-tag payload
 * (`object <sha>\ntype <type>\ntag <name>\ntagger …\n\n<message>`) inside a
 * loose tag object.
 *
 * @writes
 *   surface: tag
 *   kind:    equivalent-under-readback
 *   format:  git-tag-object
 */
import type { AuthorIdentity } from './author-identity.js';
import { parseIdentity, serializeIdentity } from './author-identity.js';
import type { ExtraHeader } from './commit.js';
import {
  decode,
  encode,
  formatContinuationHeader,
  parseHeaderLine,
  splitHeaderAndMessage,
} from './encoding.js';
import { invalidTag } from './error.js';
import type { ObjectType } from './header.js';
import type { ObjectId } from './object-id.js';
import { ObjectId as ObjectIdFactory } from './object-id.js';

export interface TagData {
  readonly object: ObjectId;
  readonly objectType: ObjectType;
  readonly tagName: string;
  readonly tagger?: AuthorIdentity;
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders: ReadonlyArray<ExtraHeader>;
}

export interface Tag {
  readonly type: 'tag';
  readonly id: ObjectId;
  readonly data: TagData;
}

const VALID_OBJECT_TYPES: ReadonlySet<string> = new Set(['blob', 'tree', 'commit', 'tag']);

// A tag's signature is appended to the message body, not carried as a
// `gpgsig` header (unlike commits) — this peels a trailing armor block off
// the raw message. The trailing `\n?` tolerates the signer's armor already
// ending in a newline without swallowing a second one.
const TAG_SIGNATURE_PATTERN =
  /-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*-----END (?:PGP|SSH) SIGNATURE-----\n?$/;

function peelTagSignature(rawMessage: string): {
  readonly message: string;
  readonly gpgSignature: string | undefined;
} {
  const match = TAG_SIGNATURE_PATTERN.exec(rawMessage);
  if (match === null) {
    return { message: rawMessage, gpgSignature: undefined };
  }
  return { message: rawMessage.slice(0, match.index), gpgSignature: match[0] };
}

export function parseTagContent(id: ObjectId, content: Uint8Array): Tag {
  const { headerPart, message: rawMessage } = splitHeaderAndMessage(decode(content));
  const lines = headerPart.split('\n');
  const { object, objectType, tagName, nextIndex: requiredEnd } = parseRequiredTagFields(lines);
  const { tagger, nextIndex } = parseTaggerField(lines, requiredEnd);
  const { extraHeaders } = parseTagOptionalHeaders(lines, nextIndex);
  const { message, gpgSignature } = peelTagSignature(rawMessage);

  return {
    type: 'tag',
    id,
    data: {
      object,
      objectType,
      tagName,
      ...(tagger !== undefined ? { tagger } : {}),
      message,
      ...(gpgSignature !== undefined ? { gpgSignature } : {}),
      extraHeaders,
    },
  };
}

function parseRequiredTagFields(lines: ReadonlyArray<string>): {
  readonly object: ObjectId;
  readonly objectType: ObjectType;
  readonly tagName: string;
  readonly nextIndex: number;
} {
  if (!lines[0]!.startsWith('object ')) {
    throw invalidTag('first line must be object');
  }
  const object = ObjectIdFactory.from(lines[0]!.slice(7));

  if (lines.length < 2 || !lines[1]!.startsWith('type ')) {
    throw invalidTag('second line must be type');
  }
  const objectTypeStr = lines[1]!.slice(5);
  if (!VALID_OBJECT_TYPES.has(objectTypeStr)) {
    throw invalidTag(`invalid object type: ${objectTypeStr}`);
  }

  if (lines.length < 3 || !lines[2]!.startsWith('tag ')) {
    throw invalidTag('third line must be tag name');
  }
  const tagName = lines[2]!.slice(4);
  if (tagName === '' || tagName.includes('\0') || tagName.includes('\n')) {
    throw invalidTag(`invalid tag name: ${tagName}`);
  }

  return { object, objectType: objectTypeStr as ObjectType, tagName, nextIndex: 3 };
}

function parseTaggerField(
  lines: ReadonlyArray<string>,
  startIndex: number,
): { readonly tagger: AuthorIdentity | undefined; readonly nextIndex: number } {
  if (startIndex < lines.length && lines[startIndex]!.startsWith('tagger ')) {
    return {
      tagger: parseIdentity(lines[startIndex]!.slice(7)),
      nextIndex: startIndex + 1,
    };
  }
  return { tagger: undefined, nextIndex: startIndex };
}

// Tags have no `gpgsig` header to special-case (the signature lives in the
// body — see `peelTagSignature`), so this walks continuation lines directly
// rather than sharing commit's `parseOptionalHeaderBlock`.
function parseTagOptionalHeaders(
  lines: ReadonlyArray<string>,
  startIndex: number,
): { readonly extraHeaders: ReadonlyArray<ExtraHeader> } {
  const extraHeaders: ExtraHeader[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const { key, value: firstValue } = parseHeaderLine(lines[i]!);
    if (key === '') {
      throw invalidTag('unexpected continuation line without preceding header');
    }
    const parts: string[] = [firstValue];
    let endIndex = i;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j]!;
      if (!nextLine.startsWith(' ')) break;
      parts.push(nextLine.slice(1));
      endIndex = j;
    }
    i = endIndex + 1;
    extraHeaders.push({ key, value: parts.join('\n') });
  }
  return { extraHeaders };
}

export function serializeTagContent(tag: Tag): Uint8Array {
  const lines: string[] = [];
  const { data } = tag;

  lines.push(`object ${data.object}`);
  lines.push(`type ${data.objectType}`);
  if (data.tagName === '' || data.tagName.includes('\n') || data.tagName.includes('\0')) {
    throw invalidTag(`invalid tag name: ${data.tagName}`);
  }
  lines.push(`tag ${data.tagName}`);

  if (data.tagger !== undefined) {
    lines.push(`tagger ${serializeIdentity(data.tagger)}`);
  }

  for (const header of data.extraHeaders) {
    lines.push(formatContinuationHeader(header.key, header.value));
  }

  const headerText = lines.join('\n');
  // A tag's signature is appended straight onto the message body (unlike a
  // commit's `gpgsig` header) — real `git tag -s` concatenates the signer's
  // armor byte-for-byte with no separator and no header wrapping.
  const body =
    data.gpgSignature !== undefined ? `${data.message}${data.gpgSignature}` : data.message;
  return encode(`${headerText}\n\n${body}`);
}
