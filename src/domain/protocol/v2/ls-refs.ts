import { ObjectId } from '../../objects/object-id.js';
import { invalidRefLine, tooManyAdvertisedRefs } from '../error.js';
import type { PktLine } from '../pkt-line.js';
import { type AdvertisedRef, type Advertisement, MAX_ADVERTISED_REFS } from '../upload-pack.js';
import { encodeCommandRequest } from './sections.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const SHA_ANY_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const SYMREF_TARGET_PREFIX = 'symref-target:';
const PEELED_PREFIX = 'peeled:';

export interface LsRefsRequestOptions {
  readonly symrefs?: boolean;
  readonly peel?: boolean;
  readonly refPrefixes?: ReadonlyArray<string>;
}

const refPrefixLine = (prefix: string): Uint8Array => TEXT_ENCODER.encode(`ref-prefix ${prefix}\n`);

export const buildLsRefsRequest = (options: LsRefsRequestOptions): Uint8Array => {
  const payloads: Uint8Array[] = [];
  if (options.symrefs === true) payloads.push(TEXT_ENCODER.encode('symrefs\n'));
  if (options.peel === true) payloads.push(TEXT_ENCODER.encode('peel\n'));
  for (const prefix of options.refPrefixes ?? []) payloads.push(refPrefixLine(prefix));
  return encodeCommandRequest('ls-refs', [], payloads);
};

const stripTrailingNewline = (value: string): string =>
  value.endsWith('\n') ? value.slice(0, -1) : value;

const findAttribute = (attrs: ReadonlyArray<string>, prefix: string): string | undefined => {
  const match = attrs.find((attr) => attr.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
};

interface ParsedRefLine {
  readonly name: string;
  readonly oidToken: string;
  readonly symrefTarget?: string;
  readonly peeled?: string;
}

const parseRefLine = (line: string): ParsedRefLine => {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx < 0) throw invalidRefLine(line);
  const oidToken = line.slice(0, spaceIdx);
  const [name, ...attrs] = line.slice(spaceIdx + 1).split(' ');
  if (name === undefined || name.length === 0) throw invalidRefLine(line);

  const symrefTarget = findAttribute(attrs, SYMREF_TARGET_PREFIX);
  if (symrefTarget !== undefined) return { name, oidToken, symrefTarget };

  const peeled = findAttribute(attrs, PEELED_PREFIX);
  return peeled === undefined ? { name, oidToken } : { name, oidToken, peeled };
};

const validateOidString = (token: string, line: string): ObjectId => {
  if (!SHA_ANY_RE.test(token)) throw invalidRefLine(line);
  return ObjectId.from(token);
};

/**
 * Mirrors `findHead` (v1's `upload-pack.ts`): a direct `HEAD` ref entry (a
 * detached HEAD, carrying no `symref-target` attribute) wins; otherwise the
 * recorded symref target is looked up among the parsed refs. An unresolved
 * target (including the unborn-HEAD case, where the branch does not exist
 * yet) yields no head at all — the same "no oid" outcome v1 produces for a
 * broken `symref=HEAD:` capability.
 */
const findLsRefsHead = (
  refs: ReadonlyArray<AdvertisedRef>,
  headSymrefTarget: string | undefined,
): AdvertisedRef | undefined => {
  const directHead = refs.find((ref) => ref.name === 'HEAD');
  if (directHead) return directHead;
  if (headSymrefTarget === undefined) return undefined;
  const targetRef = refs.find((ref) => ref.name === headSymrefTarget);
  return targetRef === undefined ? undefined : { name: 'HEAD', id: targetRef.id };
};

/**
 * Bounds the ref count before appending, mirroring v1's `collectRefs` cap: a
 * hostile server could otherwise flood the response with refs to exhaust
 * heap on the client.
 */
const pushAdvertisedRef = (refs: AdvertisedRef[], parsed: ParsedRefLine, line: string): void => {
  if (refs.length >= MAX_ADVERTISED_REFS) {
    throw tooManyAdvertisedRefs(refs.length + 1, MAX_ADVERTISED_REFS);
  }
  const id = validateOidString(parsed.oidToken, line);
  refs.push(
    parsed.peeled === undefined
      ? { id, name: parsed.name }
      : { id, name: parsed.name, peeled: validateOidString(parsed.peeled, line) },
  );
};

export const parseLsRefsResponse = async (
  pktStream: AsyncIterable<PktLine>,
): Promise<Advertisement> => {
  const iter = pktStream[Symbol.asyncIterator]();
  const refs: AdvertisedRef[] = [];
  let headSymrefTarget: string | undefined;

  let pkt = await iter.next();
  while (!pkt.done) {
    if (pkt.value.kind !== 'data') break;
    const line = stripTrailingNewline(TEXT_DECODER.decode(pkt.value.payload));
    const parsed = parseRefLine(line);

    if (parsed.symrefTarget !== undefined) {
      if (parsed.name === 'HEAD') headSymrefTarget = parsed.symrefTarget;
    } else {
      pushAdvertisedRef(refs, parsed, line);
    }
    pkt = await iter.next();
  }

  const head = findLsRefsHead(refs, headSymrefTarget);
  const capabilities = headSymrefTarget === undefined ? [] : [`symref=HEAD:${headSymrefTarget}`];
  return head === undefined ? { capabilities, refs } : { capabilities, refs, head };
};
