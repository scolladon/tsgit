import { encodePktLine, encodePktStream } from '../../../src/domain/protocol/pkt-line.js';

const ENC = new TextEncoder();
const NUL = '\0';

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
};

const bytesOf = (s: string): Uint8Array => ENC.encode(s);

export interface BuiltDiscovery {
  readonly service: 'git-upload-pack' | 'git-receive-pack';
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
    readonly peeled?: string;
  }>;
}

/**
 * Build a discovery response body matching real git-http-backend output.
 * Format: pkt-line "# service=<service>\n", flush, first ref with NUL-suffix
 * capabilities, subsequent refs, peeled tags as "<oid> <name>^{}\n", flush.
 */
export const buildDiscoveryBody = (d: BuiltDiscovery): Uint8Array => {
  const headerStream = encodePktStream([bytesOf(`# service=${d.service}\n`)]);
  const refLines: Uint8Array[] = [];
  d.refs.forEach((r, idx) => {
    const tail = idx === 0 ? `${NUL}${d.capabilities.join(' ')}` : '';
    refLines.push(bytesOf(`${r.id} ${r.name}${tail}\n`));
    if (r.peeled !== undefined) {
      refLines.push(bytesOf(`${r.peeled} ${r.name}^{}\n`));
    }
  });
  const refStream = encodePktStream(refLines);
  return concat(headerStream, refStream);
};

export interface BuiltUploadPackResponse {
  readonly acks?: ReadonlyArray<{
    readonly id: string;
    readonly status: 'ack' | 'continue' | 'common' | 'ready';
  }>;
  readonly packBytes: Uint8Array;
  readonly sideBand: boolean;
  readonly progressLines?: ReadonlyArray<string>;
  /** oids emitted as `shallow <oid>` lines before the ACK/NAK block. */
  readonly shallow?: ReadonlyArray<string>;
  /** oids emitted as `unshallow <oid>` lines before the ACK/NAK block. */
  readonly unshallow?: ReadonlyArray<string>;
}

const sideBandPayload = (channel: number, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
};

const ackText = (a: { id: string; status: 'ack' | 'continue' | 'common' | 'ready' }): string =>
  a.status === 'ack' ? `ACK ${a.id}\n` : `ACK ${a.id} ${a.status}\n`;

/**
 * Build a single-round clone/fetch upload-pack response: optional shallow
 * block (shallow/unshallow + flush), optional ACK lines, NAK,
 * then a sideband-1 wrapper around `packBytes`, then flush.
 */
export const buildUploadPackResponseBody = (opts: BuiltUploadPackResponse): Uint8Array => {
  const shallowLines = (opts.shallow ?? []).map((oid) => bytesOf(`shallow ${oid}\n`));
  const unshallowLines = (opts.unshallow ?? []).map((oid) => bytesOf(`unshallow ${oid}\n`));
  const shallowSection =
    shallowLines.length + unshallowLines.length > 0
      ? encodePktStream([...shallowLines, ...unshallowLines])
      : new Uint8Array(0);
  const payloads: Uint8Array[] = [];
  for (const a of opts.acks ?? []) payloads.push(bytesOf(ackText(a)));
  payloads.push(bytesOf('NAK\n'));
  if (opts.sideBand) {
    for (const line of opts.progressLines ?? []) {
      payloads.push(sideBandPayload(2, bytesOf(line)));
    }
    payloads.push(sideBandPayload(1, opts.packBytes));
  } else {
    // Without sideband, the pack bytes go in raw pkt-line payloads. Real
    // git would emit them as a stream of pkt-lines or as raw bytes after a
    // NAK-terminated flush; for our fixture, just emit one big data line if
    // it fits, else wrap in encodePktLine pieces.
    if (opts.packBytes.byteLength > 0) payloads.push(opts.packBytes);
  }
  const tail = encodePktStream(payloads);
  return concat(shallowSection, tail);
};

export interface BuiltReceivePackResponse {
  readonly unpackResult: 'ok' | string;
  readonly refResults: ReadonlyArray<{ readonly name: string; readonly result: 'ok' | string }>;
}

export const buildReceivePackResponseBody = (opts: BuiltReceivePackResponse): Uint8Array => {
  const payloads: Uint8Array[] = [];
  payloads.push(bytesOf(`unpack ${opts.unpackResult}\n`));
  for (const r of opts.refResults) {
    if (r.result === 'ok') {
      payloads.push(bytesOf(`ok ${r.name}\n`));
    } else {
      payloads.push(bytesOf(`ng ${r.name} ${r.result}\n`));
    }
  }
  return encodePktStream(payloads);
};

// Re-exported for convenience in fixtures (kept here so fixtures don't pull
// from the production tree directly).
export { encodePktLine };
