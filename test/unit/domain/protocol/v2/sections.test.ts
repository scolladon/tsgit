import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../../src/domain/error.js';
import { AGENT } from '../../../../../src/domain/protocol/capabilities.js';
import { decodePktStream, type PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import {
  encodeCommandRequest,
  readSections,
  type Section,
} from '../../../../../src/domain/protocol/v2/sections.js';

const ENCODER = new TextEncoder();
const bytesOf = (s: string): Uint8Array => ENCODER.encode(s);

const DELIM = bytesOf('0001');
const FLUSH = bytesOf('0000');

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

function pktBytes(text: string): Uint8Array {
  const total = bytesOf(text).byteLength + 4;
  return bytesOf(total.toString(16).padStart(4, '0') + text);
}

async function* asyncOf(chunks: ReadonlyArray<Uint8Array>): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

async function collect(source: AsyncIterable<PktLine>): Promise<PktLine[]> {
  const out: PktLine[] = [];
  for await (const pkt of source) out.push(pkt);
  return out;
}

const decodeAll = (bytes: Uint8Array): Promise<PktLine[]> =>
  collect(decodePktStream(asyncOf([bytes]), { v2: true }));

const dataLine = (text: string): PktLine => ({ kind: 'data', payload: bytesOf(text) });

type CollectedSection = { readonly name: Section['name']; readonly lines: PktLine[] };

async function collectSections(pktStream: AsyncIterable<PktLine>): Promise<CollectedSection[]> {
  const out: CollectedSection[] = [];
  for await (const section of readSections(pktStream)) {
    out.push({ name: section.name, lines: await collect(section.lines) });
  }
  return out;
}

describe('encodeCommandRequest', () => {
  describe('Given a command, args, and payloads', () => {
    describe('When encodeCommandRequest builds the request', () => {
      it('Then it emits command header, delim, args, flush in order', async () => {
        // Arrange
        const sut = encodeCommandRequest;

        // Act
        const bytes = sut('ls-refs', ['symrefs', 'peel'], [bytesOf('ref-prefix HEAD\n')]);
        const lines = await decodeAll(bytes);

        // Assert
        expect(lines).toEqual([
          dataLine('command=ls-refs\n'),
          dataLine(`${AGENT}\n`),
          dataLine('object-format=sha1\n'),
          { kind: 'delim' },
          dataLine('symrefs\n'),
          dataLine('peel\n'),
          dataLine('ref-prefix HEAD\n'),
          { kind: 'flush' },
        ]);
      });
    });
  });
});

describe('readSections', () => {
  describe('Given a decoded v2 section stream', () => {
    describe('When readSections drains the stream', () => {
      it.each([
        {
          buildStream: () =>
            asyncOf([
              concatBytes(
                pktBytes('acknowledgments\n'),
                pktBytes('ACK 1111111111111111111111111111111111111111\n'),
                DELIM,
                pktBytes('packfile\n'),
                pktBytes('PACK-DATA'),
                FLUSH,
              ),
            ]),
          expected: [
            {
              name: 'acknowledgments',
              lines: [dataLine('ACK 1111111111111111111111111111111111111111\n')],
            },
            { name: 'packfile', lines: [dataLine('PACK-DATA')] },
          ],
          label:
            'it yields both sections, in order, with their own lines, for two sections separated by a delim and terminated by a flush',
        },
        {
          // The terminator's `kind` is 'flush', not 'delim', so `continues`
          // must be false; treating any non-done boundary (or any boundary at
          // all) as `continues: true` would make readSections keep reading
          // and misparse the stray bytes below as another section header.
          buildStream: () =>
            asyncOf([
              concatBytes(
                pktBytes('packfile\n'),
                pktBytes('PACK-DATA'),
                FLUSH,
                pktBytes('garbage\n'),
              ),
            ]),
          expected: [{ name: 'packfile', lines: [dataLine('PACK-DATA')] }],
          label:
            'it yields the one section and never reads past its terminating flush, for a single section followed by stray bytes',
        },
        {
          buildStream: () => asyncOf([FLUSH]),
          expected: [],
          label: 'it yields no sections, for a response with zero sections (an immediate flush)',
        },
        {
          buildStream: () => asyncOf([concatBytes(pktBytes('packfile\n'), pktBytes('PACK-DATA'))]),
          expected: [{ name: 'packfile', lines: [dataLine('PACK-DATA')] }],
          label:
            'it yields the single section and stops without throwing, for a body with no terminating delim or flush',
        },
        {
          buildStream: () => asyncOf([concatBytes(pktBytes('packfile'), FLUSH)]),
          expected: [{ name: 'packfile', lines: [] }],
          label:
            'it is still recognised as a valid section name, for a header with no trailing newline',
        },
      ])('Then $label', async ({ buildStream, expected }) => {
        // Arrange
        const stream = buildStream();

        // Act
        const sut = await collectSections(decodePktStream(stream, { v2: true }));

        // Assert
        expect(sut).toEqual(expected);
      });
    });
  });

  describe('Given a stream whose section header is unrecognised', () => {
    describe('When readSections runs', () => {
      it('Then it throws UNEXPECTED_V2_SECTION carrying the header', async () => {
        // Arrange
        const stream = asyncOf([concatBytes(pktBytes('bogus\n'), FLUSH)]);

        // Act
        let sut: unknown;
        try {
          await collectSections(decodePktStream(stream, { v2: true }));
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual({
          code: 'UNEXPECTED_V2_SECTION',
          section: 'bogus',
        });
      });
    });
  });
});
