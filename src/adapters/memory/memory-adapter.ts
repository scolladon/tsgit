import { type Context, createContext, type RepositoryConfig } from '../../ports/context.js';
import { noopProgressReporter } from '../../ports/progress-reporter.js';
import { MemoryCompressor } from './memory-compressor.js';
import { MemoryFileSystem, type MemoryFileSystemOptions } from './memory-file-system.js';
import { MemoryHashService } from './memory-hash-service.js';
import { MemoryHttpTransport } from './memory-http-transport.js';

export interface MemoryAdapterOptions {
  readonly files?: Readonly<Record<string, Uint8Array>>;
  readonly algorithm?: 'sha1' | 'sha256';
  readonly signal?: AbortSignal;
}

const DEFAULT_WORK_DIR = '/repo';
const DEFAULT_GIT_DIR = '/repo/.git';

export function createMemoryContext(options: MemoryAdapterOptions = {}): Context {
  const fsOptions: MemoryFileSystemOptions =
    options.files === undefined
      ? { rootDir: DEFAULT_WORK_DIR }
      : { rootDir: DEFAULT_WORK_DIR, files: options.files };
  const fs = new MemoryFileSystem(fsOptions);
  const hash = new MemoryHashService(options.algorithm ?? 'sha1');
  const compressor = new MemoryCompressor();
  const transport = new MemoryHttpTransport();
  const config: RepositoryConfig = {
    workDir: DEFAULT_WORK_DIR,
    gitDir: DEFAULT_GIT_DIR,
    bare: false,
  };
  const parts = { fs, hash, compressor, transport, progress: noopProgressReporter, config };
  return options.signal === undefined
    ? createContext(parts)
    : createContext({ ...parts, signal: options.signal });
}
