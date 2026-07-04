import { ObjectId } from '../../objects/object-id.js';
import type { PktLine } from '../pkt-line.js';
import { parseSideBand } from '../side-band.js';
import { type AckEntry, parseAckLine, tryConsumeShallowLine } from '../upload-pack.js';
import { encodeCommandRequest, readSections } from './sections.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export interface V2FetchRequestOptions {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly haves: ReadonlyArray<ObjectId>;
  readonly args?: ReadonlyArray<string>;
  readonly done?: boolean;
}

export interface WantedRef {
  readonly id: ObjectId;
  readonly name: string;
}

export interface V2FetchResponse {
  readonly acks: ReadonlyArray<AckEntry>;
  readonly nak: boolean;
  readonly ready: boolean;
  readonly packBody: AsyncIterable<Uint8Array>;
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
  readonly wantedRefs: ReadonlyArray<WantedRef>;
}

const wantLine = (oid: ObjectId): Uint8Array => TEXT_ENCODER.encode(`want ${oid}\n`);
const haveLine = (oid: ObjectId): Uint8Array => TEXT_ENCODER.encode(`have ${oid}\n`);
const DONE_LINE = TEXT_ENCODER.encode('done\n');

export const buildV2FetchRequest = (options: V2FetchRequestOptions): Uint8Array => {
  const payloads: Uint8Array[] = [...options.wants.map(wantLine), ...options.haves.map(haveLine)];
  if (options.done === true) payloads.push(DONE_LINE);
  return encodeCommandRequest('fetch', options.args ?? [], payloads);
};

/**
 * `readSections` (see sections.ts) only ever yields `data` pkt-lines through a
 * section's `lines` view — the boundary line (delim/flush/response-end) that
 * ends a section is detected internally and never handed to the consumer.
 * The cast documents that guarantee instead of adding an unreachable branch.
 */
const dataPayload = (pkt: PktLine): Uint8Array =>
  (pkt as Extract<PktLine, { kind: 'data' }>).payload;

interface AcknowledgmentsResult {
  readonly acks: ReadonlyArray<AckEntry>;
  readonly nak: boolean;
  readonly ready: boolean;
}

const parseAcknowledgments = async (
  lines: AsyncIterable<PktLine>,
): Promise<AcknowledgmentsResult> => {
  const acks: AckEntry[] = [];
  let nak = false;
  let ready = false;
  for await (const pkt of lines) {
    const text = TEXT_DECODER.decode(dataPayload(pkt));
    if (text.startsWith('ACK ')) {
      acks.push(parseAckLine(text));
      continue;
    }
    if (text.startsWith('NAK')) {
      nak = true;
      continue;
    }
    // Neither ACK nor NAK: per protocol-v2, the only remaining line an
    // acknowledgments section carries is `ready`.
    ready = true;
  }
  return { acks, nak, ready };
};

interface ShallowInfoResult {
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

const parseShallowInfo = async (lines: AsyncIterable<PktLine>): Promise<ShallowInfoResult> => {
  const state = { shallow: [] as ObjectId[], unshallow: [] as ObjectId[] };
  for await (const pkt of lines) {
    tryConsumeShallowLine(TEXT_DECODER.decode(dataPayload(pkt)), state);
  }
  return state;
};

const parseWantedRefLine = (line: string): WantedRef => {
  const spaceIdx = line.indexOf(' ');
  const name = line.slice(spaceIdx + 1).replace(/\n$/, '');
  return { id: ObjectId.from(line.slice(0, spaceIdx)), name };
};

const parseWantedRefs = async (
  lines: AsyncIterable<PktLine>,
): Promise<ReadonlyArray<WantedRef>> => {
  const wantedRefs: WantedRef[] = [];
  for await (const pkt of lines) {
    wantedRefs.push(parseWantedRefLine(TEXT_DECODER.decode(dataPayload(pkt))));
  }
  return wantedRefs;
};

async function* emptyPackBody(): AsyncGenerator<Uint8Array, void, unknown> {}

export const parseV2FetchResponse = async (
  pktStream: AsyncIterable<PktLine>,
): Promise<V2FetchResponse> => {
  let acks: ReadonlyArray<AckEntry> = [];
  let nak = false;
  let ready = false;
  let shallow: ReadonlyArray<ObjectId> = [];
  let unshallow: ReadonlyArray<ObjectId> = [];
  let wantedRefs: ReadonlyArray<WantedRef> = [];
  let packBody: AsyncIterable<Uint8Array> = emptyPackBody();

  for await (const section of readSections(pktStream)) {
    if (section.name === 'acknowledgments') {
      const parsed = await parseAcknowledgments(section.lines);
      acks = parsed.acks;
      nak = parsed.nak;
      ready = parsed.ready;
      continue;
    }
    if (section.name === 'shallow-info') {
      const parsed = await parseShallowInfo(section.lines);
      shallow = parsed.shallow;
      unshallow = parsed.unshallow;
      continue;
    }
    if (section.name === 'wanted-refs') {
      wantedRefs = await parseWantedRefs(section.lines);
      continue;
    }
    packBody = parseSideBand(section.lines, {});
  }

  return { acks, nak, ready, packBody, shallow, unshallow, wantedRefs };
};
