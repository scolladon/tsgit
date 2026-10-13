import type { ChunkTransform } from './chunk-transform.js';
import { encodeExpandedKeyword } from './ident.js';

const DOLLAR = 0x24;
const COLON = 0x3a;
const SPACE = 0x20;
const LF = 0x0a;
const NUL = 0x00;
const KEYWORD_PREFIX = Uint8Array.of(DOLLAR, 0x49, 0x64);
const COLON_INDEX = 3;
const VALUE_INDEX = 5;
const NOT_IN_CHUNK = -1;
const INITIAL_CAPACITY = 64;
// git's sane isspace: only these four count, not VT or FF.
const WHITESPACE: ReadonlySet<number> = new Set([SPACE, 0x09, LF, 0x0d]);

type Verdict = 'more' | 'literal' | 'expand' | 'nul';

// git scans the keyword as a C string: the scan stops at the first NUL.
const isForeignKeyword = (keyword: Uint8Array): boolean => {
  if (keyword[COLON_INDEX + 1] !== SPACE) return false;
  // Stryker disable next-line ArithmeticOperator: equivalent — the keyword always ends in `$` (not whitespace) and reads past it are undefined, so a wider bound visits nothing new
  for (let at = VALUE_INDEX; at < keyword.length - 1; at++) {
    const byte = keyword[at] as number;
    if (byte === NUL) return false;
    if (WHITESPACE.has(byte) && keyword[at + 1] !== DOLLAR) return true;
  }
  return false;
};

interface HeldBytes {
  readonly append: (byte: number) => void;
  readonly set: (bytes: Uint8Array) => void;
  readonly view: () => Uint8Array;
  readonly copy: () => Uint8Array;
  readonly clear: () => void;
}

const createHeldBytes = (): HeldBytes => {
  let store = new Uint8Array(INITIAL_CAPACITY);
  let length = 0;
  const reserve = (needed: number): void => {
    if (needed <= store.length) return;
    const grown = new Uint8Array(Math.max(needed, store.length * 2));
    grown.set(store.subarray(0, length));
    store = grown;
  };
  return {
    append: (byte) => {
      reserve(length + 1);
      store[length++] = byte;
    },
    set: (bytes) => {
      reserve(bytes.length);
      store.set(bytes);
      length = bytes.length;
    },
    view: () => store.subarray(0, length),
    copy: () => store.slice(0, length),
    clear: () => {
      length = 0;
    },
  };
};

export const createIdentTransform = (oidHex: string): ChunkTransform => {
  const expansion = encodeExpandedKeyword(oidHex);
  const held = createHeldBytes();
  let matched = 0;
  let collecting = false;
  let literalNext = false;
  // Where the partial match began in the chunk being scanned; NOT_IN_CHUNK once it was carried over.
  let matchStart = NOT_IN_CHUNK;
  let out: Uint8Array[] = [];
  let runStart = 0;
  let current: Uint8Array = new Uint8Array(0);

  const reset = (): void => {
    matched = 0;
    collecting = false;
    matchStart = NOT_IN_CHUNK;
    held.clear();
  };

  const stepCollecting = (byte: number, keyword: () => Uint8Array): Verdict => {
    if (byte === LF) return 'literal';
    if (byte !== DOLLAR) return 'more';
    return isForeignKeyword(keyword()) ? 'literal' : 'expand';
  };

  const stepAfterName = (byte: number): Verdict => {
    if (byte === DOLLAR) return 'expand';
    if (byte === NUL) return 'nul';
    if (byte !== COLON) return 'literal';
    collecting = true;
    return 'more';
  };

  const step = (byte: number, keyword: () => Uint8Array): Verdict => {
    if (collecting) return stepCollecting(byte, keyword);
    if (matched === KEYWORD_PREFIX.length) return stepAfterName(byte);
    if (byte !== KEYWORD_PREFIX[matched]) return 'literal';
    matched++;
    return 'more';
  };

  const carryOver = (chunk: Uint8Array): void => {
    if (matchStart === NOT_IN_CHUNK) return;
    held.set(chunk.subarray(matchStart));
    matchStart = NOT_IN_CHUNK;
  };

  const run = (from: number, to: number): void => {
    if (to <= from) return;
    out.push(from === 0 && to === current.length ? current : current.subarray(from, to));
  };

  const settle = (verdict: Verdict, at: number): void => {
    const inChunk = matchStart !== NOT_IN_CHUNK;
    if (verdict === 'expand') {
      run(runStart, matchStart);
      out.push(expansion);
      runStart = at + 1;
    } else if (!inChunk) {
      // A prefix from an earlier chunk is gone from the stream, so it needs its own piece.
      out.push(held.copy());
      runStart = at + 1;
    }
    literalNext = verdict === 'nul';
    reset();
  };

  const settleUnless = (verdict: Verdict, at: number): void => {
    if (verdict !== 'more') settle(verdict, at);
  };

  const advance = (at: number): Verdict => {
    const byte = current[at] as number;
    const start = matchStart;
    if (start === NOT_IN_CHUNK) held.append(byte);
    return step(byte, () =>
      start === NOT_IN_CHUNK ? held.view() : current.subarray(start, at + 1),
    );
  };

  const seekDollar = (from: number): number => {
    const dollar = current.indexOf(DOLLAR, from);
    if (dollar === -1) return current.length;
    matched = 1;
    matchStart = dollar;
    return dollar;
  };

  const scan = (): void => {
    for (let at = 0; at < current.length; at++) {
      if (literalNext) literalNext = false;
      else if (matched === 0) at = seekDollar(at);
      else settleUnless(advance(at), at);
    }
  };

  const finish = (): void => {
    if (matched === 0) {
      run(runStart, current.length);
      return;
    }
    run(runStart, matchStart);
    carryOver(current);
  };

  const push = (chunk: Uint8Array): ReadonlyArray<Uint8Array> => {
    out = [];
    current = chunk;
    runStart = 0;
    scan();
    finish();
    return out;
  };

  const flush = (): ReadonlyArray<Uint8Array> => {
    const rest = held.copy();
    reset();
    literalNext = false;
    return rest.length === 0 ? [] : [rest];
  };

  return { push, flush };
};
