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
  describe('Given an empty opts object', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange / Act / Assert
        expect(() => validateOptions({})).not.toThrow();
      });
    });
  });

  describe('Given fully-populated valid opts', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange / Act / Assert
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
  });
});

describe('validateOptions — opts.cwd', () => {
  describe("Given opts.cwd = 'relative/path'", () => {
    describe('When validateOptions runs', () => {
      it("Then throws INVALID_OPTION with .option === 'cwd'", () => {
        // Arrange + Assert
        expectInvalid(() => validateOptions({ cwd: 'relative/path' }), 'cwd', 'absolute');
      });
    });
  });

  describe("Given opts.cwd = '' (empty string)", () => {
    describe('When validateOptions runs', () => {
      it("Then throws INVALID_OPTION with .option === 'cwd'", () => {
        // Arrange + Assert
        expectInvalid(() => validateOptions({ cwd: '' }), 'cwd', 'absolute');
      });
    });
  });

  describe("Given opts.cwd = '/abs/path' (absolute)", () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ cwd: '/abs/path' })).not.toThrow();
      });
    });
  });

  describe('Given opts.cwd is a Windows UNC path', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw (UNC prefix is checked at the START)', () => {
        // Arrange — a UNC root `\\server\share` is absolute. The guard inspects the
        // *start* of the value for the `\\` prefix; this path starts with `\\` but
        // does NOT end with it, so a startsWith→endsWith mutation would reject it.
        const cwd = '\\\\server\\share';

        // Act / Assert
        expect(() => validateOptions({ cwd })).not.toThrow();
      });
    });
  });
});

describe('validateOptions — opts.config.parallelism', () => {
  describe('Given parallelism = 0', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { parallelism: 0 } }),
          'parallelism',
          '1..32',
        );
      });
    });
  });

  describe('Given parallelism = 33', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { parallelism: 33 } }),
          'parallelism',
          '1..32',
        );
      });
    });
  });

  describe('Given parallelism = 1 (lower boundary)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { parallelism: 1 } })).not.toThrow();
      });
    });
  });

  describe('Given parallelism = 32 (upper boundary)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { parallelism: 32 } })).not.toThrow();
      });
    });
  });

  describe('Given parallelism = 1.5 (non-integer)', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { parallelism: 1.5 } }),
          'parallelism',
          'integer',
        );
      });
    });
  });
});

describe('validateOptions — opts.config.maxResponseBytes', () => {
  describe('Given maxResponseBytes = 1023', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { maxResponseBytes: 1023 } }),
          'maxResponseBytes',
          '>= 1024',
        );
      });
    });
  });

  describe('Given maxResponseBytes = 1024 (boundary)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { maxResponseBytes: 1024 } })).not.toThrow();
      });
    });
  });
});

describe('validateOptions — opts.config.breakStaleLockMs', () => {
  describe('Given breakStaleLockMs = -1', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { breakStaleLockMs: -1 } }),
          'breakStaleLockMs',
          '>= 0',
        );
      });
    });
  });

  describe('Given breakStaleLockMs = 0 (boundary)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { breakStaleLockMs: 0 } })).not.toThrow();
      });
    });
  });
});

describe('validateOptions — opts.config.maxObjectsPerPack', () => {
  describe('Given maxObjectsPerPack = 0', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { maxObjectsPerPack: 0 } }),
          'maxObjectsPerPack',
          '>= 1',
        );
      });
    });
  });

  describe('Given maxObjectsPerPack = 1 (boundary)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { maxObjectsPerPack: 1 } })).not.toThrow();
      });
    });
  });
});

describe('validateOptions — opts.config.maxDnsResults', () => {
  describe('Given maxDnsResults = 0', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        expectInvalid(
          () => validateOptions({ config: { maxDnsResults: 0 } }),
          'maxDnsResults',
          '>= 1',
        );
      });
    });
  });

  describe('Given maxDnsResults = 1 (boundary)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { maxDnsResults: 1 } })).not.toThrow();
      });
    });
  });

  describe('Given maxDnsResults = 64 (default)', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { maxDnsResults: 64 } })).not.toThrow();
      });
    });
  });
});

describe('validateOptions — opts.config.dnsResolver', () => {
  describe('Given dnsResolver passed as a non-function via unsafe cast', () => {
    describe('When validateOptions runs', () => {
      it('Then throws INVALID_OPTION', () => {
        // Arrange + Assert
        // TypeScript blocks the unsafe shape at compile time; the runtime guard is the second line of defense.
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
    });
  });

  describe('Given dnsResolver = an actual function', () => {
    describe('When validateOptions runs', () => {
      it('Then it does not throw', () => {
        // Arrange + Assert
        expect(() => validateOptions({ config: { dnsResolver: async () => [] } })).not.toThrow();
      });
    });
  });
});

// Re-exported only inside the test file for the unsafe-cast scenario.
type RepositoryConfigDnsResolver = (host: string) => Promise<ReadonlyArray<string>>;
