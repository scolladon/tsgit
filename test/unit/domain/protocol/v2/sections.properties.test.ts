import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import {
  encodeCommandRequest,
  readSections,
  type Section,
} from '../../../../../src/domain/protocol/v2/sections.js';
import {
  argsArb,
  commandArb,
  payloadsArb,
  type SectionFixture,
  sectionFixturesArb,
} from './arbitraries.js';

const RUNS = 200;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

async function* asyncBytes(chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

function pktBytes(text: string): Uint8Array {
  const total = ENCODER.encode(text).byteLength + 4;
  return ENCODER.encode(total.toString(16).padStart(4, '0') + text);
}

const DELIM = ENCODER.encode('0001');
const FLUSH = ENCODER.encode('0000');

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const buildSectionsStream = (fixtures: ReadonlyArray<SectionFixture>): Uint8Array => {
  if (fixtures.length === 0) return FLUSH;
  const frames = fixtures.map((fixture, index) => {
    const header = pktBytes(`${fixture.name}\n`);
    const lines = fixture.lines.map((line) => pktBytes(`${line}\n`));
    const boundary = index === fixtures.length - 1 ? FLUSH : DELIM;
    return concatBytes(header, ...lines, boundary);
  });
  return concatBytes(...frames);
};

type CollectedSection = {
  readonly name: SectionFixture['name'];
  readonly lines: ReadonlyArray<string>;
};

async function drainSections(sections: AsyncIterable<Section>): Promise<CollectedSection[]> {
  const out: CollectedSection[] = [];
  for await (const section of sections) {
    const lines: string[] = [];
    for await (const line of section.lines) {
      lines.push(DECODER.decode(line.payload).replace(/\n$/, ''));
    }
    out.push({ name: section.name, lines });
  }
  return out;
}

async function collect(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const out: PktLine[] = [];
  for await (const pkt of source) out.push(pkt);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncBytes([bytes]), { v2: true }));

const objectFormatArb = (): fc.Arbitrary<'sha1' | 'sha256'> => fc.constantFrom('sha1', 'sha256');

describe('Given an arbitrary command name, arg list, payload set, and object format', () => {
  describe('When encodeCommandRequest is built and decoded', () => {
    it('Then the decoded frames reproduce command-header ∘ delim ∘ args ∘ flush', async () => {
      // Arrange & Act & Assert
      await fc.assert(
        fc.asyncProperty(
          commandArb(),
          argsArb(),
          payloadsArb(),
          objectFormatArb(),
          async (command, args, payloads, objectFormat) => {
            const bytes = encodeCommandRequest(command, args, payloads, objectFormat);
            const lines = await decodeAll(bytes);

            expect(lines[0]).toEqual({
              kind: 'data',
              payload: ENCODER.encode(`command=${command}\n`),
            });
            expect(lines[1]).toEqual({ kind: 'data', payload: ENCODER.encode(`${AGENT}\n`) });
            expect(lines[2]).toEqual({
              kind: 'data',
              payload: ENCODER.encode(`object-format=${objectFormat}\n`),
            });
            expect(lines[3]).toEqual({ kind: 'delim' });

            const bodyStart = 4;
            args.forEach((arg, i) => {
              expect(lines[bodyStart + i]).toEqual({
                kind: 'data',
                payload: ENCODER.encode(`${arg}\n`),
              });
            });

            const payloadStart = bodyStart + args.length;
            payloads.forEach((payload, i) => {
              expect(lines[payloadStart + i]).toEqual({ kind: 'data', payload });
            });

            const flushIdx = payloadStart + payloads.length;
            expect(lines).toHaveLength(flushIdx + 1);
            expect(lines[flushIdx]).toEqual({ kind: 'flush' });
          },
        ),
        { numRuns: RUNS },
      );
    });
  });
});

describe('Given an arbitrary set of known sections and their data lines', () => {
  describe('When serialized to pkt-lines and parsed back via readSections', () => {
    it('Then each section name and its line list round-trip exactly', async () => {
      // Arrange & Act & Assert
      await fc.assert(
        fc.asyncProperty(sectionFixturesArb(), async (fixtures) => {
          const bytes = buildSectionsStream(fixtures);
          const stream = decodePktStream(asyncBytes([bytes]), { v2: true });

          const collected = await drainSections(readSections(stream));

          expect(collected).toEqual(fixtures);
        }),
        { numRuns: RUNS },
      );
    });
  });
});
