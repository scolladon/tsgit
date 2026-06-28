import type { EnvReader } from '../../ports/env-reader.js';

export class NodeEnvReader implements EnvReader {
  get(name: string): string | undefined {
    return process.env[name];
  }
}
