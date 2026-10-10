const LINE_FEED = '\n';
const CONTINUATION = ' ';
const ANY_SIGNATURE_HEADER = 'gpgsig';
const SIGNATURE_HEADERS = { sha1: 'gpgsig', sha256: 'gpgsig-sha256' } as const;

/** The header a commit is signed under in a repository of `algorithm` (git's `gpg_sig_headers`). */
export const signatureHeaderFor = (algorithm: keyof typeof SIGNATURE_HEADERS): string =>
  SIGNATURE_HEADERS[algorithm];

export interface SignedCommit {
  /** The commit bytes the signature covers: every signature header removed. */
  readonly payload: Uint8Array;
  /** The detached signature, continuation lines unfolded. */
  readonly signature: Uint8Array;
}

interface SplitState {
  readonly payload: string[];
  readonly signature: string[];
  inSignature: boolean;
  otherSignature: boolean;
}

const toByteString = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

const fromByteString = (text: string): Uint8Array =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));

const signatureLine = (state: SplitState, line: string, header: string): string | undefined => {
  if (state.inSignature && line.startsWith(CONTINUATION)) return line.slice(1);
  if (line.startsWith(`${header} `)) return line.slice(header.length + 1);
  if (line.startsWith(ANY_SIGNATURE_HEADER)) state.otherSignature = true;
  else if (!line.startsWith(CONTINUATION)) state.otherSignature = false;
  return undefined;
};

/** Consumes one line; returns where the next starts (the end once the message is reached). */
const splitLine = (state: SplitState, text: string, at: number, header: string): number => {
  const feed = text.indexOf(LINE_FEED, at);
  const next = feed === -1 ? text.length : feed + 1;
  const line = text.slice(at, next);
  const signed = signatureLine(state, line, header);
  state.inSignature = signed !== undefined;
  if (signed !== undefined) {
    state.signature.push(signed);
    return next;
  }
  const end = line.startsWith(LINE_FEED) ? text.length : next;
  if (!state.otherSignature) state.payload.push(text.slice(at, end));
  return end;
};

/**
 * git's `parse_buffer_signed_by_header`: the signature under `header` (the repository hash's
 * `gpgsig` header) is split off; any other hash's signature header is dropped from the payload.
 */
export const splitSignedCommit = (raw: Uint8Array, header: string): SignedCommit | undefined => {
  const text = toByteString(raw);
  const state: SplitState = {
    payload: [],
    signature: [],
    inSignature: false,
    otherSignature: false,
  };
  let at = 0;
  while (at < text.length) at = splitLine(state, text, at, header);
  if (state.signature.length === 0) return undefined;
  return {
    payload: fromByteString(state.payload.join('')),
    signature: fromByteString(state.signature.join('')),
  };
};
