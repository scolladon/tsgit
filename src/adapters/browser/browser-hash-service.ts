/// <reference lib="dom" />
import { hashFailed } from '../../domain/index.js';
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

  async hash(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest(this.algoName, data as BufferSource));
  }

  async hashHex(data: Uint8Array): Promise<string> {
    return toHex(await this.hash(data));
  }

  createHasher(): Hasher {
    const chunks: Uint8Array[] = [];
    const algoName = this.algoName;
    let consumed = false;

    const finalize = async (): Promise<Uint8Array> => {
      if (consumed) throw hashFailed('cannot digest after digest');
      consumed = true;
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const concatenated = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.length;
      }
      return new Uint8Array(await crypto.subtle.digest(algoName, concatenated as BufferSource));
    };

    return {
      update(data: Uint8Array): void {
        if (consumed) throw hashFailed('cannot update after digest');
        chunks.push(data.slice());
      },
      digest: finalize,
      digestHex: async () => toHex(await finalize()),
    };
  }

  private get algoName(): SubtleAlgorithm {
    return this.algorithm === 'sha1' ? 'SHA-1' : 'SHA-256';
  }
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}
