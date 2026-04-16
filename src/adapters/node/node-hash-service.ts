import { createHash } from 'node:crypto';
import { hashFailed } from '../../domain/index.js';
import type { Hasher, HashService } from '../../ports/hash-service.js';

type Algorithm = 'sha1' | 'sha256';

const DIGEST_LENGTH: Record<Algorithm, 20 | 32> = {
  sha1: 20,
  sha256: 32,
};

export class NodeHashService implements HashService {
  readonly algorithm: Algorithm;
  readonly digestLength: 20 | 32;

  constructor(algorithm: Algorithm = 'sha1') {
    this.algorithm = algorithm;
    this.digestLength = DIGEST_LENGTH[algorithm];
  }

  hash = async (data: Uint8Array): Promise<Uint8Array> => {
    return new Uint8Array(createHash(this.algorithm).update(data).digest());
  };

  hashHex = async (data: Uint8Array): Promise<string> => {
    return createHash(this.algorithm).update(data).digest('hex');
  };

  createHasher = (): Hasher => {
    const inner = createHash(this.algorithm);
    let consumed = false;
    return {
      update: (data: Uint8Array): void => {
        if (consumed) throw hashFailed('cannot update after digest');
        inner.update(data);
      },
      digest: async (): Promise<Uint8Array> => {
        if (consumed) throw hashFailed('cannot digest after digest');
        consumed = true;
        return new Uint8Array(inner.digest());
      },
      digestHex: async (): Promise<string> => {
        if (consumed) throw hashFailed('cannot digest after digest');
        consumed = true;
        return inner.digest('hex');
      },
    };
  };
}
