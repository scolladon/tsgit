const DOLLAR = 0x24;
const UPPER_I = 0x49;
const LOWER_D = 0x64;
const COLON = 0x3a;
const SPACE = 0x20;
const LF = 0x0a;
const KEYWORD_NAME_LENGTH = 2;
const KEYWORD_COLON_LENGTH = 3;
const FOREIGN_SEARCH_START = 4;
const COLLAPSED_NAME = Uint8Array.of(UPPER_I, LOWER_D);

interface Match {
  readonly replacement: Uint8Array;
  readonly resumeAt: number;
}

type MatchAt = (bytes: Uint8Array, afterDollar: number) => Match | undefined;

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const rewrite = (bytes: Uint8Array, matchAt: MatchAt): Uint8Array => {
  const parts: Uint8Array[] = [];
  let copied = 0;
  let dollar = bytes.indexOf(DOLLAR);
  while (dollar !== -1) {
    const match = matchAt(bytes, dollar + 1);
    if (match === undefined) {
      dollar = bytes.indexOf(DOLLAR, dollar + 1);
      continue;
    }
    parts.push(bytes.subarray(copied, dollar + 1), match.replacement);
    copied = match.resumeAt;
    dollar = bytes.indexOf(DOLLAR, copied);
  }
  if (parts.length === 0) return bytes;
  parts.push(bytes.subarray(copied));
  return concat(parts);
};

const startsWithName = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === UPPER_I && bytes[at + 1] === LOWER_D;

const closingDollar = (bytes: Uint8Array, afterColon: number): number | undefined => {
  const closing = bytes.indexOf(DOLLAR, afterColon);
  if (closing === -1) return undefined;
  const lineBreak = bytes.indexOf(LF, afterColon);
  return lineBreak !== -1 && lineBreak < closing ? undefined : closing;
};

const collapseAt: MatchAt = (bytes, afterDollar) => {
  if (bytes.length - afterDollar <= KEYWORD_COLON_LENGTH) return undefined;
  if (!startsWithName(bytes, afterDollar) || bytes[afterDollar + KEYWORD_NAME_LENGTH] !== COLON) {
    return undefined;
  }
  const closing = closingDollar(bytes, afterDollar + KEYWORD_COLON_LENGTH);
  if (closing === undefined) return undefined;
  return { replacement: COLLAPSED_NAME, resumeAt: closing };
};

export const identToGit = (bytes: Uint8Array): Uint8Array => rewrite(bytes, collapseAt);

const encoder = new TextEncoder();

export const encodeExpandedKeyword = (oidHex: string): Uint8Array =>
  encoder.encode(`$Id: ${oidHex} $`);

const isForeign = (bytes: Uint8Array, afterDollar: number, closing: number): boolean => {
  const space = bytes.indexOf(SPACE, afterDollar + FOREIGN_SEARCH_START);
  return space !== -1 && space < closing - 1;
};

const expandAt =
  (expansion: Uint8Array): MatchAt =>
  (bytes, afterDollar) => {
    if (bytes.length - afterDollar < KEYWORD_COLON_LENGTH) return undefined;
    if (!startsWithName(bytes, afterDollar)) return undefined;
    const terminator = bytes[afterDollar + KEYWORD_NAME_LENGTH];
    if (terminator === DOLLAR) {
      return { replacement: expansion, resumeAt: afterDollar + KEYWORD_COLON_LENGTH };
    }
    if (terminator !== COLON) return undefined;
    const closing = closingDollar(bytes, afterDollar + KEYWORD_COLON_LENGTH);
    if (closing === undefined || isForeign(bytes, afterDollar, closing)) return undefined;
    return { replacement: expansion, resumeAt: closing + 1 };
  };

export const identToWorkingTree = (bytes: Uint8Array, oidHex: string): Uint8Array =>
  rewrite(bytes, expandAt(encodeExpandedKeyword(oidHex).subarray(1)));
