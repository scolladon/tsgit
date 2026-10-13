const NUL = 0x00;
const BS = 0x08;
const HT = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SUB = 0x1a;
const ESC = 0x1b;
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;
const PRINTABLE_RATIO_SHIFT = 7;

export interface TextStats {
  readonly nul: number;
  readonly loneCr: number;
  readonly loneLf: number;
  readonly crlf: number;
  readonly printable: number;
  readonly nonPrintable: number;
}

const isPrintableControl = (byte: number): boolean =>
  byte === BS || byte === HT || byte === ESC || byte === FF;

export const gatherTextStats = (bytes: Uint8Array): TextStats => {
  let nul = 0;
  let loneCr = 0;
  let loneLf = 0;
  let crlf = 0;
  let printable = 0;
  let nonPrintable = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte === CR) {
      if (bytes[i + 1] === LF) {
        crlf++;
        i++;
      } else {
        loneCr++;
      }
      continue;
    }
    if (byte === LF) {
      loneLf++;
      continue;
    }
    if (byte === DEL) {
      nonPrintable++;
      continue;
    }
    if (byte >= FIRST_PRINTABLE || isPrintableControl(byte)) {
      printable++;
      continue;
    }
    if (byte === NUL) nul++;
    nonPrintable++;
  }
  if (bytes[bytes.length - 1] === SUB) nonPrintable--;
  return { nul, loneCr, loneLf, crlf, printable, nonPrintable };
};

export const isBinaryText = (stats: TextStats): boolean =>
  stats.loneCr > 0 ||
  stats.nul > 0 ||
  stats.printable >> PRINTABLE_RATIO_SHIFT < stats.nonPrintable;
