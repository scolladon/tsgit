import type { ChunkTransform } from './chunk-transform.js';
import { encodeExpandedKeyword } from './ident.js';

const DOLLAR = 0x24;
const COLON = 0x3a;
const SPACE = 0x20;
const LF = 0x0a;
const KEYWORD_PREFIX = Uint8Array.of(DOLLAR, 0x49, 0x64);
const COLON_INDEX = 3;
const VALUE_INDEX = 5;
const WHITESPACE: ReadonlySet<number> = new Set([SPACE, 0x09, LF, 0x0b, 0x0c, 0x0d]);

const isForeignKeyword = (keyword: Uint8Array): boolean => {
  if (keyword[COLON_INDEX + 1] !== SPACE) return false;
  for (let at = VALUE_INDEX; at < keyword.length - 1; at++) {
    if (WHITESPACE.has(keyword[at] as number) && keyword[at + 1] !== DOLLAR) return true;
  }
  return false;
};

export const createIdentTransform = (oidHex: string): ChunkTransform => {
  const expansion = encodeExpandedKeyword(oidHex);
  let matched = 0;
  let collecting = false;
  let collected: number[] = [];

  const pending = (): Uint8Array =>
    collecting
      ? Uint8Array.from([...KEYWORD_PREFIX, ...collected])
      : KEYWORD_PREFIX.slice(0, matched);

  const reset = (emitted: Uint8Array): Uint8Array => {
    matched = 0;
    collecting = false;
    collected = [];
    return emitted;
  };

  const withTail = (tail: number): Uint8Array => Uint8Array.from([...pending(), tail]);

  const stepAfterName = (byte: number): Uint8Array | undefined => {
    if (byte === DOLLAR) return reset(expansion);
    if (byte !== COLON) return reset(withTail(byte));
    collecting = true;
    collected = [COLON];
    return undefined;
  };

  const stepCollecting = (byte: number): Uint8Array | undefined => {
    if (byte === LF) return reset(withTail(byte));
    if (byte !== DOLLAR) {
      collected.push(byte);
      return undefined;
    }
    const keyword = withTail(byte);
    return reset(isForeignKeyword(keyword) ? keyword : expansion);
  };

  const step = (byte: number): Uint8Array | undefined => {
    if (collecting) return stepCollecting(byte);
    if (matched === KEYWORD_PREFIX.length) return stepAfterName(byte);
    if (byte !== KEYWORD_PREFIX[matched]) return reset(withTail(byte));
    matched++;
    return undefined;
  };

  const push = (chunk: Uint8Array): ReadonlyArray<Uint8Array> => {
    const out: Uint8Array[] = [];
    const run = (from: number, to: number): void => {
      if (to <= from) return;
      out.push(from === 0 && to === chunk.length ? chunk : chunk.subarray(from, to));
    };
    let runStart = 0;
    for (let at = 0; at < chunk.length; at++) {
      if (matched === 0) {
        const dollar = chunk.indexOf(DOLLAR, at);
        if (dollar === -1) break;
        run(runStart, dollar);
        matched = 1;
        at = dollar;
        continue;
      }
      const emitted = step(chunk[at] as number);
      if (emitted === undefined) continue;
      out.push(emitted);
      runStart = at + 1;
    }
    if (matched === 0) run(runStart, chunk.length);
    return out;
  };

  const flush = (): ReadonlyArray<Uint8Array> => {
    const rest = reset(pending());
    return rest.length === 0 ? [] : [rest];
  };

  return { push, flush };
};
