import { invalidOption } from '../domain/commands/error.js';
import type { RepositoryConfig } from '../ports/context.js';

/**
 * Subset of `OpenRepositoryOptions` validated here. The full facade-entry type
 * extends this with adapters / signal / progress / unsafeRawAdapters which
 * have no value-domain validation (their typing covers what's checkable).
 */
interface ValidatableOptions {
  readonly cwd?: string;
  readonly config?: RepositoryConfig;
}

const PARALLELISM_MIN = 1;
const PARALLELISM_MAX = 32;
const MAX_RESPONSE_BYTES_MIN = 1024;

/**
 * Eager option validation per Phase 10 §8.1. Throws `INVALID_OPTION` (with
 * sanitized reason) on the first violation; never coalesces — the caller
 * fixes one issue at a time.
 *
 * Mutation-resistance directives:
 * - Boundaries are tested in isolated triples (low-1 / low / high / high+1)
 *   so the comparison operators (`<` vs `<=`) cannot be silently mutated.
 * - Each guard is a separate `if` so the StatementRemoval mutator on one
 *   guard fails its dedicated test rather than passing through another.
 */
export const validateOptions = (opts: ValidatableOptions): void => {
  if (opts.cwd !== undefined && !isAbsolutePath(opts.cwd)) {
    throw invalidOption('cwd', 'must be an absolute path');
  }
  const config = opts.config;
  if (config === undefined) return;
  validateParallelism(config.parallelism);
  validateMaxResponseBytes(config.maxResponseBytes);
  validateBreakStaleLockMs(config.breakStaleLockMs);
  validateMaxObjectsPerPack(config.maxObjectsPerPack);
  validateMaxDnsResults(config.maxDnsResults);
  validateDnsResolver(config.dnsResolver);
};

// Cross-platform absolute-path check. POSIX paths start with '/'. Windows
// paths start with a drive-letter prefix (`C:\`, case-insensitive on `[A-Z]`)
// or a UNC root (`\\server\share\…`). Both forms come out of `nodePath.resolve()`
// in the Node shim, so users on Windows must not be rejected here.
const ABS_WINDOWS = /^[A-Za-z]:[/\\]/;
const isAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || value.startsWith('\\\\') || ABS_WINDOWS.test(value);

const validateParallelism = (value: number | undefined): void => {
  if (value === undefined) return;
  if (!Number.isInteger(value)) {
    throw invalidOption('parallelism', 'must be an integer');
  }
  if (value < PARALLELISM_MIN || value > PARALLELISM_MAX) {
    throw invalidOption('parallelism', `must be in 1..32 (got ${value})`);
  }
};

const validateMaxResponseBytes = (value: number | undefined): void => {
  if (value === undefined) return;
  if (value < MAX_RESPONSE_BYTES_MIN) {
    throw invalidOption('maxResponseBytes', `must be >= 1024 (got ${value})`);
  }
};

const validateBreakStaleLockMs = (value: number | undefined): void => {
  if (value === undefined) return;
  if (value < 0) {
    throw invalidOption('breakStaleLockMs', `must be >= 0 (got ${value})`);
  }
};

const validateMaxObjectsPerPack = (value: number | undefined): void => {
  if (value === undefined) return;
  if (value < 1) {
    throw invalidOption('maxObjectsPerPack', `must be >= 1 (got ${value})`);
  }
};

const validateMaxDnsResults = (value: number | undefined): void => {
  if (value === undefined) return;
  if (value < 1) {
    throw invalidOption('maxDnsResults', `must be >= 1 (got ${value})`);
  }
};

const validateDnsResolver = (value: RepositoryConfig['dnsResolver'] | undefined): void => {
  if (value === undefined) return;
  if (typeof value !== 'function') {
    throw invalidOption('dnsResolver', 'must be a function');
  }
};
