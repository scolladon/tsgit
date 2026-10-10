/**
 * iconv's stateful `ISO-2022-JP` encoder, its tables derived from the WHATWG decoder: ASCII
 * first, then JIS X 0201 Roman, then JIS X 0208, each run opened by its escape sequence and
 * the output closed back in ASCII. Characters outside the three sets fail the conversion.
 */

type CharacterSet = 'ascii' | 'roman' | 'jis0208';
type Table = ReadonlyMap<number, ReadonlyArray<number>>;

const ESC = 0x1b;
const DESIGNATE: Readonly<Record<CharacterSet, ReadonlyArray<number>>> = {
  ascii: [ESC, 0x28, 0x42],
  roman: [ESC, 0x28, 0x4a],
  jis0208: [ESC, 0x24, 0x42],
};
const ASCII_END = 0x80;
const FIRST_GRAPHIC = 0x21;
const LAST_GRAPHIC = 0x7e;
/** JIS X 0208's standard rows, 1–8 and 16–84; the rest are vendor extensions iconv lacks. */
const STANDARD_ROWS: ReadonlyArray<readonly [number, number]> = [
  [0x21, 0x28],
  [0x30, 0x74],
];
const LABELS: ReadonlySet<string> = new Set(['iso-2022-jp', 'csiso2022jp']);

export const isIso2022JpLabel = (label: string): boolean => LABELS.has(label);

/** The one code point a designated byte sequence decodes to; a fatal decode means none. */
const decodeOne = (decoder: TextDecoder, bytes: ReadonlyArray<number>): number | undefined => {
  try {
    return decoder.decode(Uint8Array.from(bytes)).codePointAt(0);
  } catch {
    return undefined;
  }
};

const graphicBytes = (from: number, to: number): ReadonlyArray<number> =>
  Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

const addFirst = (
  table: Map<number, ReadonlyArray<number>>,
  codePoint: number | undefined,
  bytes: ReadonlyArray<number>,
): void => {
  if (codePoint !== undefined && !table.has(codePoint)) table.set(codePoint, bytes);
};

/** Roman entries; iconv reaches only those that differ from ASCII, ASCII being tried first. */
const buildRoman = (decoder: TextDecoder): Table => {
  const table = new Map<number, ReadonlyArray<number>>();
  for (const byte of graphicBytes(FIRST_GRAPHIC, LAST_GRAPHIC)) {
    addFirst(table, decodeOne(decoder, [...DESIGNATE.roman, byte]), [byte]);
  }
  return table;
};

const buildJis0208 = (decoder: TextDecoder): Table => {
  const table = new Map<number, ReadonlyArray<number>>();
  for (const [first, last] of STANDARD_ROWS) {
    for (const lead of graphicBytes(first, last)) {
      for (const trail of graphicBytes(FIRST_GRAPHIC, LAST_GRAPHIC)) {
        addFirst(table, decodeOne(decoder, [...DESIGNATE.jis0208, lead, trail]), [lead, trail]);
      }
    }
  }
  return table;
};

interface Tables {
  readonly roman: Table;
  readonly jis0208: Table;
}

const buildTables = (): Tables => {
  const decoder = new TextDecoder('iso-2022-jp', { fatal: true });
  return { roman: buildRoman(decoder), jis0208: buildJis0208(decoder) };
};

interface Encoded {
  readonly set: CharacterSet;
  readonly bytes: ReadonlyArray<number>;
}

const encodeChar = (codePoint: number, { roman, jis0208 }: Tables): Encoded | undefined => {
  if (codePoint < ASCII_END) return { set: 'ascii', bytes: [codePoint] };
  const romanBytes = roman.get(codePoint);
  if (romanBytes !== undefined) return { set: 'roman', bytes: romanBytes };
  const jisBytes = jis0208.get(codePoint);
  return jisBytes === undefined ? undefined : { set: 'jis0208', bytes: jisBytes };
};

const encodeWith = (tables: Tables, text: string): Uint8Array | undefined => {
  const out: number[] = [];
  let current: CharacterSet = 'ascii';
  for (const char of text) {
    const encoded = encodeChar(char.codePointAt(0) as number, tables);
    if (encoded === undefined) return undefined;
    if (encoded.set !== current) out.push(...DESIGNATE[encoded.set]);
    out.push(...encoded.bytes);
    current = encoded.set;
  }
  if (current !== 'ascii') out.push(...DESIGNATE.ascii);
  return Uint8Array.from(out);
};

/**
 * An encoder giving the text as `ISO-2022-JP` bytes, or `undefined` when one character has no
 * form there. Building its tables decodes thousands of sequences, so callers keep the encoder.
 */
export const buildIso2022JpEncoder = (): ((text: string) => Uint8Array | undefined) => {
  const tables = buildTables();
  return (text) => encodeWith(tables, text);
};
