import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../src/domain/error.js';
import { validateOptions } from '../../../src/repository/validate-options.js';

const expectInvalid = (fn: () => void, option: string, reasonContains: string): void => {
  try {
    fn();
    expect.unreachable('expected validateOptions to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    const data = (err as TsgitError).data;
    expect(data.code).toBe('INVALID_OPTION');
    if (data.code === 'INVALID_OPTION') {
      expect(data.option).toBe(option);
      expect(data.reason).toContain(reasonContains);
    }
  }
};

describe('validateOptions — happy path', () => {
  it('Given an empty opts object, When validateOptions runs, Then it does not throw', () => {
    // Arrange / Act / Assert
    // Assert
    expect(() => validateOptions({})).not.toThrow();
  });

  it('Given fully-populated valid opts, When validateOptions runs, Then it does not throw', () => {
    // Arrange / Act / Assert
    // Assert
    expect(() =>
      validateOptions({
        cwd: '/abs/path',
        config: {
          parallelism: 8,
          maxResponseBytes: 1024,
          maxObjectsPerPack: 1,
          breakStaleLockMs: 0,
          maxDnsResults: 64,
          dnsResolver: async () => ['1.2.3.4'],
        },
      }),
    ).not.toThrow();
  });
});

describe('validateOptions — opts.cwd', () => {
  it("Given opts.cwd = 'relative/path', When validateOptions runs, Then throws INVALID_OPTION with .option === 'cwd'", () => {
    // Arrange
    // Assert
    expectInvalid(() => validateOptions({ cwd: 'relative/path' }), 'cwd', 'absolute');
  });

  it("Given opts.cwd = '' (empty string), When validateOptions runs, Then throws INVALID_OPTION with .option === 'cwd'", () => {
    // Arrange
    // Assert
    expectInvalid(() => validateOptions({ cwd: '' }), 'cwd', 'absolute');
  });

  it("Given opts.cwd = '/abs/path' (absolute), When validateOptions runs, Then it does not throw", () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ cwd: '/abs/path' })).not.toThrow();
  });

  it('Given opts.cwd is a Windows UNC path, When validateOptions runs, Then it does not throw (UNC prefix is checked at the START)', () => {
    // Arrange — a UNC root `\\server\share` is absolute. The guard inspects the
    // *start* of the value for the `\\` prefix; this path starts with `\\` but
    // does NOT end with it, so a startsWith→endsWith mutation would reject it.
    const cwd = '\\\\server\\share';

    // Act / Assert
    // Assert
    expect(() => validateOptions({ cwd })).not.toThrow();
  });
});

describe('validateOptions — opts.config.parallelism', () => {
  it('Given parallelism = 0, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(() => validateOptions({ config: { parallelism: 0 } }), 'parallelism', '1..32');
  });

  it('Given parallelism = 33, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(() => validateOptions({ config: { parallelism: 33 } }), 'parallelism', '1..32');
  });

  it('Given parallelism = 1 (lower boundary), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { parallelism: 1 } })).not.toThrow();
  });

  it('Given parallelism = 32 (upper boundary), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { parallelism: 32 } })).not.toThrow();
  });

  it('Given parallelism = 1.5 (non-integer), When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(
      () => validateOptions({ config: { parallelism: 1.5 } }),
      'parallelism',
      'integer',
    );
  });
});

describe('validateOptions — opts.config.maxResponseBytes', () => {
  it('Given maxResponseBytes = 1023, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(
      () => validateOptions({ config: { maxResponseBytes: 1023 } }),
      'maxResponseBytes',
      '>= 1024',
    );
  });

  it('Given maxResponseBytes = 1024 (boundary), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { maxResponseBytes: 1024 } })).not.toThrow();
  });
});

describe('validateOptions — opts.config.breakStaleLockMs', () => {
  it('Given breakStaleLockMs = -1, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(
      () => validateOptions({ config: { breakStaleLockMs: -1 } }),
      'breakStaleLockMs',
      '>= 0',
    );
  });

  it('Given breakStaleLockMs = 0 (boundary), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { breakStaleLockMs: 0 } })).not.toThrow();
  });
});

describe('validateOptions — opts.config.maxObjectsPerPack', () => {
  it('Given maxObjectsPerPack = 0, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(
      () => validateOptions({ config: { maxObjectsPerPack: 0 } }),
      'maxObjectsPerPack',
      '>= 1',
    );
  });

  it('Given maxObjectsPerPack = 1 (boundary), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { maxObjectsPerPack: 1 } })).not.toThrow();
  });
});

describe('validateOptions — opts.config.maxDnsResults', () => {
  it('Given maxDnsResults = 0, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // Assert
    expectInvalid(() => validateOptions({ config: { maxDnsResults: 0 } }), 'maxDnsResults', '>= 1');
  });

  it('Given maxDnsResults = 1 (boundary), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { maxDnsResults: 1 } })).not.toThrow();
  });

  it('Given maxDnsResults = 64 (default), When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { maxDnsResults: 64 } })).not.toThrow();
  });
});

describe('validateOptions — opts.config.dnsResolver', () => {
  it('Given dnsResolver passed as a non-function via unsafe cast, When validateOptions runs, Then throws INVALID_OPTION', () => {
    // Arrange
    // TypeScript blocks the unsafe shape at compile time; the runtime guard is the second line of defense.
    // Assert
    expectInvalid(
      () =>
        validateOptions({
          config: {
            dnsResolver: 'not a function' as unknown as RepositoryConfigDnsResolver,
          },
        }),
      'dnsResolver',
      'function',
    );
  });

  it('Given dnsResolver = an actual function, When validateOptions runs, Then it does not throw', () => {
    // Arrange
    // Assert
    expect(() => validateOptions({ config: { dnsResolver: async () => [] } })).not.toThrow();
  });
});

// Re-exported only inside the test file for the unsafe-cast scenario.
type RepositoryConfigDnsResolver = (host: string) => Promise<ReadonlyArray<string>>;
