import { type CommitView, parseCommitView } from './commit-view.js';
import { buildIso2022JpEncoder, isIso2022JpLabel } from './iso-2022-jp.js';

/**
 * The commit-encoding round trip behind `export-subst`. git uses `iconv`; the platform offers
 * WHATWG decoders only, so encoders are derived from them. Whatever this module cannot convert
 * is reported as `undefined`, which callers treat as git's failed `iconv` (buffer unconverted).
 */

/** One charset's encoder: the text's bytes there, or `undefined` when a character has none. */
export type CharsetEncoder = (text: string) => Uint8Array | undefined;
/**
 * The encoder for a normalised charset label, `undefined` when there is none. Building a
 * multi-byte one decodes every byte pair, so the caller decides how long encoders are kept.
 */
export type CharsetEncoders = (label: string) => CharsetEncoder | undefined;

type CodePointTable = ReadonlyMap<number, Uint8Array>;
type ByteOrder = 'big-endian' | 'little-endian';

const UTF8_LABELS: ReadonlySet<string> = new Set(['utf-8', 'utf8']);
const LATIN1_LABELS: ReadonlySet<string> = new Set(['iso-8859-1', 'iso8859-1', 'latin1']);
const UTF16_LABELS: ReadonlySet<string> = new Set(['utf-16', 'utf16']);
const UTF16_FIXED_ORDER: ReadonlyMap<string, ByteOrder> = new Map([
  ['utf-16le', 'little-endian'],
  ['utf-16be', 'big-endian'],
]);
const MULTI_BYTE: ReadonlySet<string> = new Set(['shift_jis', 'euc-jp', 'euc-kr', 'gbk', 'big5']);
const SINGLE_BYTE: ReadonlySet<string> = new Set([
  'ibm866',
  'iso-8859-2',
  'iso-8859-3',
  'iso-8859-4',
  'iso-8859-5',
  'iso-8859-6',
  'iso-8859-7',
  'iso-8859-8',
  'iso-8859-10',
  'iso-8859-13',
  'iso-8859-14',
  'iso-8859-15',
  'iso-8859-16',
  'koi8-r',
  'koi8-u',
  'macintosh',
  'windows-874',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'x-mac-cyrillic',
]);
const BYTE_VALUES = 256;
const TWO_BYTE_SEQUENCES = 0x10000;
const BYTE_MASK = 0xff;
const BOM_LENGTH = 2;
const BOM_BIG_ENDIAN = [0xfe, 0xff] as const;
const BOM_LITTLE_ENDIAN = [0xff, 0xfe] as const;
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

const normalise = (label: string): string => label.trim().toLowerCase();

export const isUtf8Label = (label: string): boolean => UTF8_LABELS.has(normalise(label));

const strictDecoder = (label: string): TextDecoder | undefined => {
  try {
    return new TextDecoder(label, { fatal: true });
  } catch {
    return undefined;
  }
};

const tryDecode = (decoder: TextDecoder, bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const addSingleCodePoint = (
  table: Map<number, Uint8Array>,
  text: string | undefined,
  bytes: number[],
): void => {
  if (text === undefined || text.length === 0) return;
  const codePoint = text.codePointAt(0) as number;
  if (String.fromCodePoint(codePoint) !== text || table.has(codePoint)) return;
  table.set(codePoint, Uint8Array.from(bytes));
};

const latin1Table = (): CodePointTable =>
  new Map(Array.from({ length: BYTE_VALUES }, (_, byte) => [byte, Uint8Array.of(byte)]));

const addSingleBytes = (table: Map<number, Uint8Array>, decoder: TextDecoder): void => {
  for (let byte = 0; byte < BYTE_VALUES; byte++) {
    addSingleCodePoint(table, tryDecode(decoder, Uint8Array.of(byte)), [byte]);
  }
};

const addBytePairs = (table: Map<number, Uint8Array>, decoder: TextDecoder): void => {
  for (let seq = 0; seq < TWO_BYTE_SEQUENCES; seq++) {
    const bytes = [seq >> 8, seq & BYTE_MASK];
    addSingleCodePoint(table, tryDecode(decoder, Uint8Array.from(bytes)), bytes);
  }
};

const singleByteTable = (decoder: TextDecoder): CodePointTable => {
  const table = new Map<number, Uint8Array>();
  addSingleBytes(table, decoder);
  return table;
};

/** Single bytes first, so a character with both forms keeps the one-byte one. */
const multiByteTable = (decoder: TextDecoder): CodePointTable => {
  const table = new Map<number, Uint8Array>();
  addSingleBytes(table, decoder);
  addBytePairs(table, decoder);
  return table;
};

const buildTable = (label: string): CodePointTable | undefined => {
  if (LATIN1_LABELS.has(label)) return latin1Table();
  const decoder = strictDecoder(label);
  if (decoder === undefined) return undefined;
  if (SINGLE_BYTE.has(decoder.encoding)) return singleByteTable(decoder);
  if (MULTI_BYTE.has(decoder.encoding)) return multiByteTable(decoder);
  return undefined;
};

const encodeWith = (table: CodePointTable, text: string): Uint8Array | undefined => {
  const parts: Uint8Array[] = [];
  for (const char of text) {
    const bytes = table.get(char.codePointAt(0) as number);
    if (bytes === undefined) return undefined;
    parts.push(bytes);
  }
  return joinParts(parts);
};

const joinParts = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const utf16Units = (text: string, order: ByteOrder): Uint8Array => {
  const out = new Uint8Array(text.length * 2);
  const [high, low] = order === 'big-endian' ? [0, 1] : [1, 0];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[i * 2 + high] = unit >> 8;
    out[i * 2 + low] = unit & BYTE_MASK;
  }
  return out;
};

/** iconv's `UTF-16`: a big-endian BOM, then big-endian code units. */
const utf16WithBom = (text: string): Uint8Array =>
  joinParts([Uint8Array.from(BOM_BIG_ENDIAN), utf16Units(text, 'big-endian')]);

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  prefix.every((byte, at) => bytes[at] === byte);

/** iconv's `UTF-16` decoder: a BOM picks the byte order, big-endian without one. */
const decodeUtf16 = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, BOM_LITTLE_ENDIAN))
    return tryDecode(new TextDecoder('utf-16le', { fatal: true }), bytes.subarray(BOM_LENGTH));
  const body = startsWith(bytes, BOM_BIG_ENDIAN) ? bytes.subarray(BOM_LENGTH) : bytes;
  return tryDecode(new TextDecoder('utf-16be', { fatal: true }), body);
};

const decodeText = (label: string, bytes: Uint8Array): string | undefined => {
  if (UTF16_LABELS.has(label)) return decodeUtf16(bytes);
  if (LATIN1_LABELS.has(label))
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const decoder = strictDecoder(label);
  return decoder === undefined ? undefined : tryDecode(decoder, bytes);
};

/** The bytes in `label`'s encoding as UTF-8, or `undefined` when git's `iconv` would fail. */
export const decodeToUtf8 = (label: string, bytes: Uint8Array): Uint8Array | undefined => {
  const text = decodeText(normalise(label), bytes);
  return text === undefined ? undefined : new TextEncoder().encode(text);
};

/** The encoder iconv offers for a normalised label, built from scratch on every call. */
export const buildCharsetEncoder = (label: string): CharsetEncoder | undefined => {
  if (UTF16_LABELS.has(label)) return utf16WithBom;
  const order = UTF16_FIXED_ORDER.get(label);
  if (order !== undefined) return (text) => utf16Units(text, order);
  if (isIso2022JpLabel(label)) return buildIso2022JpEncoder();
  const table = buildTable(label);
  return table === undefined ? undefined : (text) => encodeWith(table, text);
};

/** The UTF-8 bytes in `label`'s encoding, or `undefined` when git's `iconv` would fail. */
export const encodeFromUtf8 = (
  label: string,
  utf8: Uint8Array,
  encoders: CharsetEncoders,
): Uint8Array | undefined => {
  const text = tryDecode(UTF8_STRICT, utf8);
  if (text === undefined) return undefined;
  return encoders(normalise(label))?.(text);
};

const nonUtf8Label = (view: CommitView): string | undefined => {
  if (view.encoding === undefined) return undefined;
  const label = new TextDecoder('latin1').decode(view.encoding);
  return isUtf8Label(label) ? undefined : label;
};

/**
 * git's commit re-encoding: the whole commit buffer decoded to UTF-8 from the commit's own
 * encoding and parsed again — a failed decode leaves the view as is. The ids and the
 * encoding stay the object's own, as git reads them from the parsed commit.
 */
export const utf8View = (view: CommitView): CommitView => {
  const label = nonUtf8Label(view);
  if (label === undefined) return view;
  const decoded = decodeToUtf8(label, view.raw);
  if (decoded === undefined) return view;
  return {
    ...parseCommitView(decoded),
    tree: view.tree,
    parents: view.parents,
    encoding: view.encoding,
  };
};
