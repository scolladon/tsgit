import * as nodePath from 'node:path';
import { type Context, createContext, type RepositoryConfig } from '../../ports/context.js';
import { noopProgressReporter } from '../../ports/progress-reporter.js';
import { NodeCompressor } from './node-compressor.js';
import { NodeFileSystem } from './node-file-system.js';
import { NodeHashService } from './node-hash-service.js';
import { NodeHttpTransport } from './node-http-transport.js';

export interface NodeAdapterOptions {
  readonly workDir: string;
  readonly gitDir?: string;
  readonly bare?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly signal?: AbortSignal;
}

export function createNodeContext(options: NodeAdapterOptions): Context {
  const workDir = nodePath.resolve(options.workDir);
  const gitDir =
    options.gitDir !== undefined
      ? nodePath.resolve(options.gitDir)
      : nodePath.join(workDir, '.git');
  const fs = new NodeFileSystem(workDir);
  const hash = new NodeHashService();
  const compressor = new NodeCompressor();
  const transport = new NodeHttpTransport({
    allowInsecureHttp: options.allowInsecureHttp ?? false,
  });
  const config: RepositoryConfig = {
    workDir,
    gitDir,
    bare: options.bare ?? false,
  };
  const parts = {
    fs,
    hash,
    compressor,
    transport,
    progress: noopProgressReporter,
    config,
  };
  return options.signal !== undefined
    ? createContext({ ...parts, signal: options.signal })
    : createContext(parts);
}
