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

describe('validateOptions — invalid option values', () => {
  describe('Given an option value that fails a guard', () => {
    describe('When validateOptions runs', () => {
      it.each([
        {
          label: "a relative cwd ('relative/path')",
          fn: () => validateOptions({ cwd: 'relative/path' }),
          option: 'cwd',
          reasonContains: 'absolute',
        },
        {
          label: 'an empty-string cwd',
          fn: () => validateOptions({ cwd: '' }),
          option: 'cwd',
          reasonContains: 'absolute',
        },
        {
          label: 'parallelism = 0',
          fn: () => validateOptions({ config: { parallelism: 0 } }),
          option: 'parallelism',
          reasonContains: '1..32',
        },
        {
          label: 'parallelism = 33',
          fn: () => validateOptions({ config: { parallelism: 33 } }),
          option: 'parallelism',
          reasonContains: '1..32',
        },
        {
          label: 'parallelism = 1.5 (non-integer)',
          fn: () => validateOptions({ config: { parallelism: 1.5 } }),
          option: 'parallelism',
          reasonContains: 'integer',
        },
        {
          label: 'maxResponseBytes = 1023',
          fn: () => validateOptions({ config: { maxResponseBytes: 1023 } }),
          option: 'maxResponseBytes',
          reasonContains: '>= 1024',
        },
        {
          label: 'breakStaleLockMs = -1',
          fn: () => validateOptions({ config: { breakStaleLockMs: -1 } }),
          option: 'breakStaleLockMs',
          reasonContains: '>= 0',
        },
        {
          label: 'maxObjectsPerPack = 0',
          fn: () => validateOptions({ config: { maxObjectsPerPack: 0 } }),
          option: 'maxObjectsPerPack',
          reasonContains: '>= 1',
        },
        {
          label: 'maxDnsResults = 0',
          fn: () => validateOptions({ config: { maxDnsResults: 0 } }),
          option: 'maxDnsResults',
          reasonContains: '>= 1',
        },
        {
          label: 'dnsResolver passed as a non-function via unsafe cast',
          // TypeScript blocks the unsafe shape at compile time; the runtime guard
          // is the second line of defense.
          fn: () =>
            validateOptions({
              config: {
                dnsResolver: 'not a function' as unknown as RepositoryConfigDnsResolver,
              },
            }),
          option: 'dnsResolver',
          reasonContains: 'function',
        },
        {
          label: 'an empty-string gitDir',
          fn: () => validateOptions({ gitDir: '' }),
          option: 'gitDir',
          reasonContains: 'must not be empty',
        },
        {
          label: 'an empty-string workDir',
          fn: () => validateOptions({ workDir: '' }),
          option: 'workDir',
          reasonContains: 'must not be empty',
        },
        {
          label: 'an empty-string commonDir',
          fn: () => validateOptions({ commonDir: '' }),
          option: 'commonDir',
          reasonContains: 'must not be empty',
        },
        {
          label: 'a ceilingDirs entry that is an empty string',
          fn: () => validateOptions({ ceilingDirs: [''] }),
          option: 'ceilingDirs',
          reasonContains: 'must not be empty',
        },
        {
          label: 'a ceilingDirs entry that is relative',
          fn: () => validateOptions({ ceilingDirs: ['/abs', 'relative/path'] }),
          option: 'ceilingDirs',
          reasonContains: 'must be absolute paths',
        },
        {
          label: "trust = 'nope'",
          fn: () => validateOptions({ trust: 'nope' as unknown as TrustLiteral }),
          option: 'trust',
          reasonContains: "'ownership' or 'always'",
        },
        {
          label: "bareRepositories = 'nope'",
          fn: () =>
            validateOptions({ bareRepositories: 'nope' as unknown as BareRepositoriesLiteral }),
          option: 'bareRepositories',
          reasonContains: "'all' or 'explicit'",
        },
        {
          label: 'a trustedDirectories entry that is an empty string',
          fn: () => validateOptions({ trustedDirectories: [''] }),
          option: 'trustedDirectories',
          reasonContains: 'must not be empty',
        },
        {
          label: 'a trustedDirectories entry that is relative',
          fn: () => validateOptions({ trustedDirectories: ['/abs', 'relative/path'] }),
          option: 'trustedDirectories',
          reasonContains: "must be '*' or an absolute path",
        },
      ])('Then throws INVALID_OPTION for $label', ({ fn, option, reasonContains }) => {
        // Arrange + Assert
        expectInvalid(fn, option, reasonContains);
      });
    });
  });
});

describe('validateOptions — valid option values', () => {
  describe('Given an option value that satisfies every guard', () => {
    describe('When validateOptions runs', () => {
      it.each([
        { label: 'an empty opts object', fn: () => validateOptions({}) },
        {
          label: 'fully-populated valid opts',
          fn: () =>
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
        },
        {
          label: "an absolute cwd ('/abs/path')",
          fn: () => validateOptions({ cwd: '/abs/path' }),
        },
        {
          label: 'a Windows UNC cwd (prefix checked at the START)',
          // A UNC root `\\server\share` is absolute. The guard inspects the *start*
          // of the value for the `\\` prefix; this path starts with `\\` but does
          // NOT end with it, so a startsWith→endsWith mutation would reject it.
          fn: () => validateOptions({ cwd: '\\\\server\\share' }),
        },
        {
          label: 'parallelism = 1 (lower boundary)',
          fn: () => validateOptions({ config: { parallelism: 1 } }),
        },
        {
          label: 'parallelism = 32 (upper boundary)',
          fn: () => validateOptions({ config: { parallelism: 32 } }),
        },
        {
          label: 'maxResponseBytes = 1024 (boundary)',
          fn: () => validateOptions({ config: { maxResponseBytes: 1024 } }),
        },
        {
          label: 'breakStaleLockMs = 0 (boundary)',
          fn: () => validateOptions({ config: { breakStaleLockMs: 0 } }),
        },
        {
          label: 'maxObjectsPerPack = 1 (boundary)',
          fn: () => validateOptions({ config: { maxObjectsPerPack: 1 } }),
        },
        {
          label: 'maxDnsResults = 1 (boundary)',
          fn: () => validateOptions({ config: { maxDnsResults: 1 } }),
        },
        {
          label: 'maxDnsResults = 64 (default)',
          fn: () => validateOptions({ config: { maxDnsResults: 64 } }),
        },
        {
          label: 'dnsResolver = an actual function',
          fn: () => validateOptions({ config: { dnsResolver: async () => [] } }),
        },
        {
          label: 'a relative gitDir (resolves against cwd, not required absolute)',
          fn: () => validateOptions({ gitDir: 'relative/bare.git' }),
        },
        {
          label: 'an absolute gitDir',
          fn: () => validateOptions({ gitDir: '/abs/bare.git' }),
        },
        {
          label: 'a relative workDir (resolves against cwd, not required absolute)',
          fn: () => validateOptions({ workDir: 'relative/wt' }),
        },
        {
          label: 'an absolute workDir',
          fn: () => validateOptions({ workDir: '/abs/wt' }),
        },
        {
          label: 'a relative commonDir (resolves against cwd, not required absolute)',
          fn: () => validateOptions({ commonDir: 'rel/common' }),
        },
        {
          label: 'an absolute commonDir',
          fn: () => validateOptions({ commonDir: '/abs/common' }),
        },
        {
          label: 'ceilingDirs with only absolute, non-empty entries',
          fn: () => validateOptions({ ceilingDirs: ['/abs/one', '/abs/two'] }),
        },
        {
          label: 'an empty ceilingDirs array',
          fn: () => validateOptions({ ceilingDirs: [] }),
        },
        {
          label: 'bare true',
          fn: () => validateOptions({ bare: true }),
        },
        {
          label: 'bare false',
          fn: () => validateOptions({ bare: false }),
        },
        {
          label: "trust = 'ownership'",
          fn: () => validateOptions({ trust: 'ownership' }),
        },
        {
          label: "trust = 'always'",
          fn: () => validateOptions({ trust: 'always' }),
        },
        {
          label: "bareRepositories = 'all'",
          fn: () => validateOptions({ bareRepositories: 'all' }),
        },
        {
          label: "bareRepositories = 'explicit'",
          fn: () => validateOptions({ bareRepositories: 'explicit' }),
        },
        {
          label: "trustedDirectories = ['*']",
          fn: () => validateOptions({ trustedDirectories: ['*'] }),
        },
        {
          label: 'trustedDirectories with only absolute entries',
          fn: () => validateOptions({ trustedDirectories: ['/abs/one', '/abs/two'] }),
        },
        {
          label: 'an empty trustedDirectories array',
          fn: () => validateOptions({ trustedDirectories: [] }),
        },
      ])('Then it does not throw for $label', ({ fn }) => {
        // Arrange + Act + Assert
        expect(fn).not.toThrow();
      });
    });
  });
});

// Re-exported only inside the test file for the unsafe-cast scenario.
type RepositoryConfigDnsResolver = (host: string) => Promise<ReadonlyArray<string>>;
type TrustLiteral = 'ownership' | 'always';
type BareRepositoriesLiteral = 'all' | 'explicit';
