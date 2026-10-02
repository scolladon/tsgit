import type { CommitView } from './commit-view.js';

/**
 * The commit-encoding round trip behind `export-subst`. git uses `iconv`; the platform offers
 * WHATWG decoders only, so encoders are derived from them. Whatever this module cannot convert
 * is reported as `undefined`, which callers treat as git's failed `iconv` (buffer unconverted).
 */

type Encoder = ReadonlyMap<number, Uint8Array>;

const UTF8_LABELS: ReadonlySet<string> = new Set(['utf-8', 'utf8']);
const LATIN1_LABELS: ReadonlySet<string> = new Set(['iso-8859-1', 'iso8859-1', 'latin1']);
const UTF16_LABELS: ReadonlySet<string> = new Set(['utf-16', 'utf16']);
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

const latin1Encoder = (): Encoder =>
  new Map(Array.from({ length: BYTE_VALUES }, (_, byte) => [byte, Uint8Array.of(byte)]));

const deriveEncoder = (decoder: TextDecoder, pairs: boolean): Encoder => {
  const table = new Map<number, Uint8Array>();
  for (let byte = 0; byte < BYTE_VALUES; byte++) {
    addSingleCodePoint(table, tryDecode(decoder, Uint8Array.of(byte)), [byte]);
  }
  for (let seq = 0; pairs && seq < TWO_BYTE_SEQUENCES; seq++) {
    const bytes = [seq >> 8, seq & BYTE_MASK];
    addSingleCodePoint(table, tryDecode(decoder, Uint8Array.from(bytes)), bytes);
  }
  return table;
};

const buildEncoder = (label: string): Encoder | undefined => {
  if (LATIN1_LABELS.has(label)) return latin1Encoder();
  const decoder = strictDecoder(label);
  if (decoder === undefined) return undefined;
  if (SINGLE_BYTE.has(decoder.encoding)) return deriveEncoder(decoder, false);
  if (MULTI_BYTE.has(decoder.encoding)) return deriveEncoder(decoder, true);
  return undefined;
};

const encoders = new Map<string, Encoder | undefined>();

const encoderFor = (label: string): Encoder | undefined => {
  if (!encoders.has(label)) encoders.set(label, buildEncoder(label));
  return encoders.get(label);
};

const encodeWith = (encoder: Encoder, text: string): Uint8Array | undefined => {
  const parts: Uint8Array[] = [];
  for (const char of text) {
    const bytes = encoder.get(char.codePointAt(0) as number);
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

const utf16WithBom = (text: string): Uint8Array => {
  const out = new Uint8Array(BOM_BIG_ENDIAN.length + text.length * 2);
  out.set(BOM_BIG_ENDIAN, 0);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[BOM_BIG_ENDIAN.length + i * 2] = unit >> 8;
    out[BOM_BIG_ENDIAN.length + i * 2 + 1] = unit & BYTE_MASK;
  }
  return out;
};

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  prefix.every((byte, at) => bytes[at] === byte);

const decodeUtf16 = (bytes: Uint8Array): string | undefined => {
  if (startsWith(bytes, BOM_BIG_ENDIAN))
    return tryDecode(new TextDecoder('utf-16be', { fatal: true }), bytes.subarray(BOM_LENGTH));
  const body = startsWith(bytes, BOM_LITTLE_ENDIAN) ? bytes.subarray(BOM_LENGTH) : bytes;
  return tryDecode(new TextDecoder('utf-16le', { fatal: true }), body);
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

/** The UTF-8 bytes in `label`'s encoding, or `undefined` when git's `iconv` would fail. */
export const encodeFromUtf8 = (label: string, utf8: Uint8Array): Uint8Array | undefined => {
  const text = tryDecode(UTF8_STRICT, utf8);
  if (text === undefined) return undefined;
  const key = normalise(label);
  if (UTF16_LABELS.has(key)) return utf16WithBom(text);
  const encoder = encoderFor(key);
  return encoder === undefined ? undefined : encodeWith(encoder, text);
};

const BYTE_FIELDS = ['author', 'committer', 'message', 'subject', 'body'] as const;

const nonUtf8Label = (view: CommitView): string | undefined => {
  if (view.encoding === undefined) return undefined;
  const label = new TextDecoder('latin1').decode(view.encoding);
  return isUtf8Label(label) ? undefined : label;
};

/**
 * The view with every byte field decoded to UTF-8 from the commit's own encoding, as git's
 * commit re-encoding does; one undecodable field leaves the whole view as is.
 */
export const utf8View = (view: CommitView): CommitView => {
  const label = nonUtf8Label(view);
  if (label === undefined) return view;
  const entries: Array<[string, Uint8Array]> = [];
  for (const field of BYTE_FIELDS) {
    const bytes = view[field];
    if (bytes === undefined) continue;
    const decoded = decodeToUtf8(label, bytes);
    if (decoded === undefined) return view;
    entries.push([field, decoded]);
  }
  return { ...view, ...Object.fromEntries(entries) };
};
