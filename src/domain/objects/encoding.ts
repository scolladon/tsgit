const HEX_TABLE: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export function bytesToHex(bytes: Uint8Array): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = HEX_TABLE[bytes[i]!]!;
  }
  return parts.join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const high = parseHexDigit(hex.charCodeAt(i));
    const low = parseHexDigit(hex.charCodeAt(i + 1));
    if (high === -1 || low === -1) {
      throw new Error(`Invalid hex character at position ${i}`);
    }
    bytes[i / 2] = (high << 4) | low;
  }
  return bytes;
}

function parseHexDigit(charCode: number): number {
  if (charCode >= 48 && charCode <= 57) return charCode - 48;
  if (charCode >= 97 && charCode <= 102) return charCode - 87;
  return -1;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

export function indexOf(bytes: Uint8Array, target: number, fromIndex: number): number {
  for (let i = fromIndex; i < bytes.length; i++) {
    if (bytes[i] === target) return i;
  }
  return -1;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encode(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function splitHeaderAndMessage(text: string): {
  readonly headerPart: string;
  readonly message: string;
} {
  const blankIndex = text.indexOf('\n\n');
  return blankIndex === -1
    ? { headerPart: text, message: '' }
    : { headerPart: text.slice(0, blankIndex), message: text.slice(blankIndex + 2) };
}

export function formatContinuationHeader(key: string, value: string): string {
  if (key.includes('\n') || key.includes(' ') || key === '') {
    throw new Error(`invalid header key: ${key}`);
  }
  const valueParts = value.split('\n');
  const first = `${key} ${valueParts[0]}`;
  const rest = valueParts.slice(1).map((line) => ` ${line}`);
  return [first, ...rest].join('\n');
}

export function parseHeaderLine(line: string): { readonly key: string; readonly value: string } {
  const spaceIdx = line.indexOf(' ');
  return spaceIdx === -1
    ? { key: line, value: '' }
    : { key: line.slice(0, spaceIdx), value: line.slice(spaceIdx + 1) };
}

export function parseOptionalHeaderBlock(
  lines: ReadonlyArray<string>,
  startIndex: number,
  onInvalidKey: (msg: string) => never,
  onDuplicateGpgsig: (msg: string) => never,
): {
  readonly gpgSignature: string | undefined;
  readonly extraHeaders: ReadonlyArray<{ readonly key: string; readonly value: string }>;
} {
  let gpgSignature: string | undefined;
  const extraHeaders: { readonly key: string; readonly value: string }[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const { key, value: firstValue } = parseHeaderLine(lines[i]!);
    if (key === '') {
      onInvalidKey('unexpected continuation line without preceding header');
    }

    const parts: string[] = [firstValue];
    let endIdx = i;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j]!;
      if (nextLine.startsWith(' ')) {
        parts.push(nextLine.slice(1));
        endIdx = j;
      } else {
        break;
      }
    }
    i = endIdx + 1;
    const value = parts.join('\n');

    if (key === 'gpgsig') {
      if (gpgSignature !== undefined) {
        onDuplicateGpgsig('duplicate gpgsig header');
      }
      gpgSignature = value;
    } else {
      extraHeaders.push({ key, value });
    }
  }

  return { gpgSignature, extraHeaders };
}
