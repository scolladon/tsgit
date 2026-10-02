import { concatBytes } from '../objects/encoding.js';

export type DecorationKind =
  | 'head'
  | 'branch'
  | 'remote'
  | 'tag'
  | 'stash'
  | 'other'
  | 'grafted'
  | 'replaced';

/** `name` is the full ref name (`HEAD` for the head); `attachedTo` is the branch HEAD points at. */
export interface Decoration {
  readonly kind: DecorationKind;
  readonly name: string;
  readonly attachedTo?: string;
}

export interface DecorationOptions {
  readonly prefix?: Uint8Array;
  readonly suffix?: Uint8Array;
  readonly separator?: Uint8Array;
  readonly pointer?: Uint8Array;
  readonly tag?: Uint8Array;
}

const encoder = new TextEncoder();
const SHORTENED_PREFIXES = ['refs/heads/', 'refs/tags/', 'refs/remotes/'];
const NO_BYTES = new Uint8Array();

const DEFAULTS = {
  prefix: encoder.encode(' ('),
  suffix: encoder.encode(')'),
  separator: encoder.encode(', '),
  pointer: encoder.encode(' -> '),
  tag: encoder.encode('tag: '),
};

const shortName = (name: string): string => {
  const prefix = SHORTENED_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? name.slice(prefix.length) : name;
};

const nameBytes = (name: string): Uint8Array => encoder.encode(shortName(name));

/** The branch HEAD points at, when it is decorated too: git shows it as `HEAD -> branch`. */
const foldedBranch = (decorations: ReadonlyArray<Decoration>): Decoration | undefined =>
  decorations.find(
    (candidate) =>
      candidate.kind === 'branch' &&
      decorations.some((other) => other.attachedTo === candidate.name),
  );

const entry = (
  decoration: Decoration,
  folded: Decoration | undefined,
  settings: Required<DecorationOptions>,
): Uint8Array[] => {
  const pieces: Uint8Array[] = [];
  if (decoration.kind === 'tag') pieces.push(settings.tag);
  pieces.push(nameBytes(decoration.name));
  if (folded && decoration.kind === 'head') pieces.push(settings.pointer, nameBytes(folded.name));
  return pieces;
};

/** `format_decorations` of git's `log-tree.c`, over decorations already in git's order. */
export const formatDecorations = (
  decorations: ReadonlyArray<Decoration>,
  options: DecorationOptions,
): Uint8Array => {
  if (decorations.length === 0) return NO_BYTES;
  const settings = { ...DEFAULTS, ...options };
  const folded = foldedBranch(decorations);
  const pieces: Uint8Array[] = [];
  let lead = settings.prefix;
  for (const decoration of decorations) {
    if (decoration === folded) continue;
    pieces.push(lead, ...entry(decoration, folded, settings));
    lead = settings.separator;
  }
  pieces.push(settings.suffix);
  return concatBytes(pieces);
};

export interface DecoratePlaceholder {
  readonly options: DecorationOptions;
  readonly length: number;
}

const OPEN = '(decorate';
const OPTION_NAMES = ['prefix', 'suffix', 'separator', 'pointer', 'tag'] as const;
const HEX_PAIR = /^[0-9a-fA-F]{2}/;
const HEX_RADIX = 16;
const HEX_ESCAPE_LENGTH = 3;

const fromLatin1 = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));

/** `expand_string_arg`: `%%`, `%n` and `%xNN` expand, any other `%` stays as it is. */
const expandValue = (raw: string): Uint8Array => {
  let expanded = '';
  let at = 0;
  while (at < raw.length) {
    const char = raw[at++] as string;
    if (char !== '%') {
      expanded += char;
    } else if (raw[at] === '%') {
      expanded += raw[at++];
    } else if (raw[at] === 'n') {
      expanded += '\n';
      at++;
    } else if (raw[at] === 'x' && HEX_PAIR.test(raw.slice(at + 1))) {
      expanded += String.fromCharCode(Number.parseInt(raw.slice(at + 1, at + 3), HEX_RADIX));
      at += HEX_ESCAPE_LENGTH;
    } else {
      expanded += '%';
    }
  }
  return fromLatin1(expanded);
};

interface ParsedOption {
  readonly name: (typeof OPTION_NAMES)[number];
  readonly value: Uint8Array;
  readonly next: number;
}

/** `match_placeholder_arg_value`: `name`, then an optional `=value`, closed by `,` or `)`. */
const parseOption = (source: string, at: number): ParsedOption | undefined => {
  const name = OPTION_NAMES.find((candidate) => source.startsWith(candidate, at));
  if (!name) return undefined;
  const valueAt = at + name.length;
  const hasValue = source[valueAt] === '=';
  const end = hasValue ? valueEnd(source, valueAt + 1) : valueAt;
  if (source[end] !== ',' && source[end] !== ')') return undefined;
  const raw = hasValue ? source.slice(valueAt + 1, end) : '';
  return { name, value: expandValue(raw), next: source[end] === ',' ? end + 1 : end };
};

const valueEnd = (source: string, from: number): number => {
  const stop = source.slice(from).search(/[,)]/);
  return stop === -1 ? source.length : from + stop;
};

/** Parses `(decorate[:option=value,…])` at `at` (the open parenthesis), as `pretty.c` does. */
export const parseDecoratePlaceholder = (
  fmt: Uint8Array,
  at: number,
): DecoratePlaceholder | undefined => {
  const source = new TextDecoder('latin1').decode(fmt.subarray(at));
  if (!source.startsWith(OPEN)) return undefined;
  let cursor = OPEN.length;
  let options: DecorationOptions = {};
  if (source[cursor] === ':') {
    cursor++;
    for (let option = parseOption(source, cursor); option; option = parseOption(source, cursor)) {
      options = { ...options, [option.name]: option.value };
      cursor = option.next;
    }
  }
  return source[cursor] === ')' ? { options, length: cursor + 1 } : undefined;
};
