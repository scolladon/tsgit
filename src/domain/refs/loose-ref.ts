/**
 * Loose-ref encoder/decoder. Direct refs serialize to `<sha>\n` files under
 * `.git/refs/**`; symbolic refs serialize to `ref: <target>\n`.
 *
 * @writes
 *   surface: looseRef
 *   kind:    byte-identical
 *   format:  git-loose-ref
 */
import type { ObjectId, RefName } from '../objects/index.js';
import { invalidObjectId, ObjectId as ObjectIdFactory } from '../objects/index.js';
import { invalidRef } from './error.js';
import type { LooseRef } from './ref-types.js';
import { validateRefName } from './ref-validation.js';

export type LooseBody =
  | { readonly kind: 'unparseable' }
  | {
      readonly kind: 'direct';
      readonly id: ObjectId;
      readonly missingNewline: boolean;
      readonly trailing?: string;
    }
  | {
      readonly kind: 'symbolic';
      readonly referent: string;
      readonly missingNewline: boolean;
      readonly trailingWhitespace: boolean;
    };

const HEX_DIGITS = /^[0-9a-fA-F]+$/;
const LINE_FEED = '\n';
const SYMREF_KEYWORD = 'ref:';
const WHITESPACE = ' \t\r\n';

const isWhitespace = (char: string | undefined): boolean =>
  char !== undefined && WHITESPACE.includes(char);

const trimEndWhitespace = (text: string): string => {
  let end = text.length;
  while (end > 0 && isWhitespace(text[end - 1])) end -= 1;
  return text.slice(0, end);
};

const trimStartWhitespace = (text: string): string => {
  let start = 0;
  while (start < text.length && isWhitespace(text[start])) start += 1;
  return text.slice(start);
};

function readSymbolicBody(content: string): LooseBody {
  const body = trimEndWhitespace(content);
  const referent = trimStartWhitespace(body.slice(SYMREF_KEYWORD.length));
  if (referent === '') {
    return { kind: 'symbolic', referent, missingNewline: true, trailingWhitespace: false };
  }
  return {
    kind: 'symbolic',
    referent,
    missingNewline: !content.endsWith(LINE_FEED),
    trailingWhitespace: content.length - body.length > 1,
  };
}

function readDirectBody(content: string, hexLength: 40 | 64): LooseBody {
  const hex = content.slice(0, hexLength);
  if (hex.length !== hexLength || !HEX_DIGITS.test(hex)) return { kind: 'unparseable' };
  if (content.length > hexLength && !isWhitespace(content[hexLength])) {
    return { kind: 'unparseable' };
  }
  const id = ObjectIdFactory.from(hex.toLowerCase());
  const trailer = content.slice(hexLength);
  const missingNewline = trailer === '';
  if (missingNewline || trailer === LINE_FEED) return { kind: 'direct', id, missingNewline };
  return { kind: 'direct', id, missingNewline: false, trailing: trailer };
}

/**
 * A loose ref body under git's grammar: a symref is `ref:` plus any whitespace run, a direct
 * ref is `hexLength` hex digits of either case followed by end-of-body or whitespace.
 * The trailer after a direct oid is reported, not judged: callers decide what it costs.
 */
export function readLooseBody(content: string, hexLength: 40 | 64): LooseBody {
  return content.startsWith(SYMREF_KEYWORD)
    ? readSymbolicBody(content)
    : readDirectBody(content, hexLength);
}

export function parseLooseRef(content: string, hexLength: 40 | 64): LooseRef {
  const body = readLooseBody(content, hexLength);
  if (body.kind === 'direct') return { type: 'direct', target: body.id };
  if (body.kind === 'symbolic') return { type: 'symbolic', target: symbolicTarget(body.referent) };
  if (content === '') throw invalidRef('empty ref content');
  throw invalidObjectId(content);
}

function symbolicTarget(referent: string): RefName {
  if (referent === '') throw invalidRef('empty symbolic ref target');
  return validateRefName(referent);
}

export function serializeDirectRef(id: ObjectId): string {
  return `${id}\n`;
}

export function serializeSymbolicRef(target: RefName): string {
  return `ref: ${target}\n`;
}
