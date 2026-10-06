import { ObjectId } from '../../objects/object-id.js';
import { invalidRefLine, tooManyAdvertisedRefs } from '../error.js';
import { assertNotRemoteError, type PktLine } from '../pkt-line.js';
import { type AdvertisedRef, type Advertisement, MAX_ADVERTISED_REFS } from '../upload-pack.js';
import { encodeCommandRequest } from './sections.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const SHA_ANY_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const SYMREF_TARGET_PREFIX = 'symref-target:';
const PEELED_PREFIX = 'peeled:';
const UNBORN_OID = 'unborn';
const HEAD = 'HEAD';

export interface LsRefsRequestOptions {
  readonly symrefs?: boolean;
  readonly peel?: boolean;
  readonly refPrefixes?: ReadonlyArray<string>;
  readonly objectFormat: 'sha1' | 'sha256';
}

const refPrefixLine = (prefix: string): Uint8Array => TEXT_ENCODER.encode(`ref-prefix ${prefix}\n`);

export const buildLsRefsRequest = (options: LsRefsRequestOptions): Uint8Array => {
  const payloads: Uint8Array[] = [];
  if (options.symrefs === true) payloads.push(TEXT_ENCODER.encode('symrefs\n'));
  if (options.peel === true) payloads.push(TEXT_ENCODER.encode('peel\n'));
  for (const prefix of options.refPrefixes ?? []) payloads.push(refPrefixLine(prefix));
  return encodeCommandRequest('ls-refs', [], payloads, options.objectFormat);
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
  // Stryker disable next-line EqualityOperator: equivalent — widening to `spaceIdx <= 0` only changes behaviour at spaceIdx === 0 (a leading space), where oidToken is the empty string that the oid/unborn guard immediately below rejects with the same invalidRefLine(line), so `< 0` and `<= 0` are indistinguishable.
  if (spaceIdx < 0) throw invalidRefLine(line);
  const oidToken = line.slice(0, spaceIdx);
  if (oidToken !== UNBORN_OID && !SHA_ANY_RE.test(oidToken)) throw invalidRefLine(line);
  const rest = line.slice(spaceIdx + 1);
  const nameEndIdx = rest.indexOf(' ');
  const name = nameEndIdx === -1 ? rest : rest.slice(0, nameEndIdx);
  if (name.length === 0) throw invalidRefLine(line);
  // Stryker disable next-line ArrayDeclaration,ArithmeticOperator: equivalent — a non-[] placeholder in the nameEndIdx === -1 arm can never start with SYMREF_TARGET_PREFIX or PEELED_PREFIX so findAttribute ignores it, and shifting the slice from `nameEndIdx + 1` to `nameEndIdx - 1` only prepends the name's single last char (too short to satisfy .startsWith on either multi-char prefix) before the same trailing split, so the real attrs are unperturbed.
  const attrs = nameEndIdx === -1 ? [] : rest.slice(nameEndIdx + 1).split(' ');

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
 * git's `process_ref_v2` lists every ref line — a symref one included, under
 * its own name and the oid on its line — except an `unborn` symref, which
 * only names the branch an empty remote's HEAD points at.
 */
const isUnbornSymref = (parsed: ParsedRefLine): boolean =>
  parsed.symrefTarget !== undefined && parsed.oidToken === UNBORN_OID;

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
  try {
    const refs: AdvertisedRef[] = [];
    let headSymrefTarget: string | undefined;

    let pkt = await iter.next();
    while (!pkt.done) {
      if (pkt.value.kind !== 'data') break;
      const line = stripTrailingNewline(TEXT_DECODER.decode(pkt.value.payload));
      assertNotRemoteError(line);
      const parsed = parseRefLine(line);

      if (parsed.symrefTarget !== undefined && parsed.name === HEAD) {
        headSymrefTarget = parsed.symrefTarget;
      }
      if (!isUnbornSymref(parsed)) pushAdvertisedRef(refs, parsed, line);
      pkt = await iter.next();
    }

    const head = refs.find((ref) => ref.name === HEAD);
    const capabilities = headSymrefTarget === undefined ? [] : [`symref=HEAD:${headSymrefTarget}`];
    return head === undefined ? { capabilities, refs } : { capabilities, refs, head };
  } finally {
    // Mirrors `parseAdvertisedRefs`'s (v1 upload-pack.ts) cleanup: the raw
    // `iter.next()` loop bypasses the for-await runtime hook, so a thrown
    // parse error would otherwise leave the HTTP response reader locked.
    await iter.return?.();
  }
};
