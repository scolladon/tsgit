/// <reference lib="dom" />
import { hashFailed } from '../../domain/index.js';
import { bytesToHex } from '../../domain/objects/encoding.js';
import type { Hasher, HashService } from '../../ports/hash-service.js';

type SubtleAlgorithm = 'SHA-1' | 'SHA-256';

export class BrowserHashService implements HashService {
  readonly algorithm: 'sha1' | 'sha256';
  readonly digestLength: 20 | 32;

  constructor(algorithm: 'sha1' | 'sha256' = 'sha1') {
    if (!globalThis.crypto?.subtle) {
      throw hashFailed('crypto.subtle unavailable');
    }
    this.algorithm = algorithm;
    this.digestLength = algorithm === 'sha1' ? 20 : 32;
  }

  withAlgorithm(algorithm: 'sha1' | 'sha256'): HashService {
    return new BrowserHashService(algorithm);
  }

  async hash(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest(this.algoName, data as BufferSource));
  }

  async hashHex(data: Uint8Array): Promise<string> {
    return bytesToHex(await this.hash(data));
  }

  createHasher(): Hasher {
    const chunks: Uint8Array[] = [];
    const algoName = this.algoName;
    let consumed = false;
    let total = 0;

    const finalize = async (): Promise<Uint8Array> => {
      if (consumed) throw hashFailed('cannot digest after digest');
      consumed = true;
      const message = joinChunks(chunks, total);
      return new Uint8Array(await crypto.subtle.digest(algoName, message as BufferSource));
    };

    return {
      update(data: Uint8Array): void {
        if (consumed) throw hashFailed('cannot update after digest');
        // SubtleCrypto cannot stream, so the bytes are held until digest; the
        // copy keeps the digest bound to the bytes seen at update() time, as
        // node:crypto's consume-now hasher is, for callers that hand the same
        // chunk onward before digesting.
        chunks.push(data.slice());
        total += data.length;
      },
      digest: finalize,
      digestHex: async () => bytesToHex(await finalize()),
    };
  }

  private get algoName(): SubtleAlgorithm {
    return this.algorithm === 'sha1' ? 'SHA-1' : 'SHA-256';
  }
}

function joinChunks(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (only !== undefined) return only;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
