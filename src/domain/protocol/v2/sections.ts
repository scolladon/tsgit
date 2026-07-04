import { AGENT } from '../capabilities.js';
import { unexpectedV2Section } from '../error.js';
import { DELIM_PKT, encodePktLines, FLUSH_PKT, type PktLine } from '../pkt-line.js';

const KNOWN_SECTION_NAMES = ['acknowledgments', 'shallow-info', 'wanted-refs', 'packfile'] as const;

export type SectionName = (typeof KNOWN_SECTION_NAMES)[number];

/**
 * One named section of a v2 command response. `lines` is a lazy view over
 * the shared underlying pkt-line stream: the consumer MUST fully drain it
 * (via `for await`) before advancing `readSections` to the next section —
 * both draw from the same iterator.
 */
export type Section = {
  readonly name: SectionName;
  readonly lines: AsyncIterable<PktLine>;
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const isSectionName = (value: string): value is SectionName =>
  (KNOWN_SECTION_NAMES as ReadonlyArray<string>).includes(value);

const stripTrailingNewline = (value: string): string =>
  value.endsWith('\n') ? value.slice(0, -1) : value;

const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

export const encodeCommandRequest = (
  command: string,
  args: ReadonlyArray<string>,
  payloads: ReadonlyArray<Uint8Array>,
): Uint8Array => {
  const header = encodePktLines([
    TEXT_ENCODER.encode(`command=${command}\n`),
    TEXT_ENCODER.encode(`${AGENT}\n`),
    TEXT_ENCODER.encode('object-format=sha1\n'),
  ]);
  const body = encodePktLines([...args.map((arg) => TEXT_ENCODER.encode(`${arg}\n`)), ...payloads]);
  return concatBytes(header, DELIM_PKT, body, FLUSH_PKT);
};

/**
 * Drains one section's data lines from the shared iterator, stopping at the
 * first non-data pkt-line (or stream end). Reports via `onBoundary` whether
 * the terminator was a `delim` (more sections follow) so the outer dispatcher
 * knows whether to keep reading section headers.
 */
async function* sectionLines(
  iter: AsyncIterator<PktLine>,
  onBoundary: (continues: boolean) => void,
): AsyncGenerator<PktLine, void, unknown> {
  for (;;) {
    const next = await iter.next();
    if (next.done || next.value.kind !== 'data') {
      onBoundary(!next.done && next.value.kind === 'delim');
      return;
    }
    yield next.value;
  }
}

export async function* readSections(pktStream: AsyncIterable<PktLine>): AsyncIterable<Section> {
  const iter = pktStream[Symbol.asyncIterator]();
  let header = await iter.next();

  while (!header.done && header.value.kind === 'data') {
    const name = stripTrailingNewline(TEXT_DECODER.decode(header.value.payload));
    if (!isSectionName(name)) {
      throw unexpectedV2Section(name);
    }

    let continues = false;
    const lines = sectionLines(iter, (value) => {
      continues = value;
    });
    yield { name, lines };

    header = continues ? await iter.next() : { done: true, value: undefined };
  }
}
