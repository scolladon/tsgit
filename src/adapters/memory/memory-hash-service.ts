import { hashFailed } from '../../domain/index.js';
import type { Hasher, HashService } from '../../ports/hash-service.js';

type Algorithm = 'sha1' | 'sha256';

type Subtle = NonNullable<typeof globalThis.crypto>['subtle'];

const SUBTLE_ALGO: Record<Algorithm, string> = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
};

const DIGEST_LENGTH: Record<Algorithm, 20 | 32> = {
  sha1: 20,
  sha256: 32,
};

export class MemoryHashService implements HashService {
  readonly algorithm: Algorithm;
  readonly digestLength: 20 | 32;
  private readonly subtleAlgo: string;
  private readonly subtle: Subtle;

  constructor(algorithm: Algorithm = 'sha1') {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      throw hashFailed('crypto.subtle unavailable');
    }
    this.subtle = subtle;
    this.algorithm = algorithm;
    this.digestLength = DIGEST_LENGTH[algorithm];
    this.subtleAlgo = SUBTLE_ALGO[algorithm];
  }

  hash = async (data: Uint8Array): Promise<Uint8Array> => {
    const buffer = await this.subtle.digest(this.subtleAlgo, data as unknown as ArrayBuffer);
    return new Uint8Array(buffer);
  };

  hashHex = async (data: Uint8Array): Promise<string> => {
    const bytes = await this.hash(data);
    return bytesToHex(bytes);
  };

  createHasher = (): Hasher => {
    const chunks: Uint8Array[] = [];
    const subtle = this.subtle;
    const algo = this.subtleAlgo;
    let consumed = false;

    const doDigest = async (): Promise<Uint8Array> => {
      if (consumed) {
        throw hashFailed('cannot digest after digest');
      }
      consumed = true;
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const concatenated = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.length;
      }
      const result = await subtle.digest(algo, concatenated as unknown as ArrayBuffer);
      return new Uint8Array(result);
    };

    return {
      update: (data: Uint8Array): void => {
        if (consumed) {
          throw hashFailed('cannot update after digest');
        }
        chunks.push(data.slice());
      },
      digest: doDigest,
      digestHex: async (): Promise<string> => {
        const bytes = await doDigest();
        return bytesToHex(bytes);
      },
    };
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
