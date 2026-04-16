/// <reference lib="dom" />
import { type Context, type CreateContextParts, createContext } from '../../ports/context.js';
import { noopProgressReporter } from '../../ports/progress-reporter.js';
import { BrowserCompressor } from './browser-compressor.js';
import { BrowserFileSystem } from './browser-file-system.js';
import { BrowserHashService } from './browser-hash-service.js';
import { BrowserHttpTransport } from './browser-http-transport.js';

export interface BrowserAdapterOptions {
  readonly rootHandle: FileSystemDirectoryHandle;
  readonly gitDirName?: string;
  readonly bare?: boolean;
  readonly signal?: AbortSignal;
}

const DEFAULT_GIT_DIR_NAME = '.git';
const ROOT_WORK_DIR = '/';

export function createBrowserContext(options: BrowserAdapterOptions): Context {
  const gitDirName = options.gitDirName ?? DEFAULT_GIT_DIR_NAME;
  const parts: CreateContextParts = {
    fs: new BrowserFileSystem(options.rootHandle),
    hash: new BrowserHashService(),
    compressor: new BrowserCompressor(),
    transport: new BrowserHttpTransport(),
    progress: noopProgressReporter,
    config: {
      workDir: ROOT_WORK_DIR,
      gitDir: `${ROOT_WORK_DIR}${gitDirName}`,
      bare: options.bare ?? false,
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  return createContext(parts);
}
