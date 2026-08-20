/**
 * Unit coverage for the Node shim's layout-option plumbing
 * (`src/index.node.ts`'s `buildLayoutOptions`): `gitDir`, `trust`,
 * `trustedDirectories`, and `bareRepositories` must reach `resolveLayout`
 * ONLY when the caller actually set them — `exactOptionalPropertyTypes`
 * forbids the explicit-undefined form, and a dropped trust option silently
 * disables a security gate.
 *
 * `resolveLayout`'s OWN option-assembly re-applies the identical
 * `!== undefined` guard one layer down (`src/repository/resolve-layout.ts`),
 * so a leaked `{ field: undefined }` key from this shim is invisible to
 * every downstream consumer — it gets filtered again before it can matter.
 * The only oracle that can see this shim's own conditional-spread mutants is
 * a spy on `resolveLayout`'s call arguments, asserted by KEY PRESENCE
 * (`in`), not `toEqual` (which treats an undefined-valued key as absent).
 *
 * `trustedDirectories`'s own canonicalisation (realpath-based) is owned by
 * `canonicalize-trusted-directories.ts`, a sibling module with its own
 * coverage — this file only proves the KEY reaches `resolveLayout` at all.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/repository/resolve-layout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/repository/resolve-layout.js')>();
  return { ...actual, resolveLayout: vi.fn(actual.resolveLayout) };
});

const { resolveLayout } = await import('../../src/repository/resolve-layout.js');
const { openRepository } = await import('../../src/index.node.js');

const resolveLayoutSpy = vi.mocked(resolveLayout);

/** The 4th positional argument (`opts`) of the last `resolveLayout` call. */
const capturedOpts = (): Record<string, unknown> => {
  const call = resolveLayoutSpy.mock.calls[0];
  if (call === undefined) throw new Error('resolveLayout was not called');
  return call[3] as unknown as Record<string, unknown>;
};

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-node-trust-opts-'));
  resolveLayoutSpy.mockClear();
});

afterEach(async () => {
  await rm(tmpdir, { recursive: true, force: true });
});

describe('Given no gitDir, trust, trustedDirectories, or bareRepositories options', () => {
  describe('When openRepository runs', () => {
    it('Then none of the four are present as keys in the resolveLayout call', async () => {
      // Arrange
      const sut = openRepository;

      // Act
      const repo = await sut({ cwd: tmpdir });

      try {
        const opts = capturedOpts();

        // Assert
        expect('gitDir' in opts).toBe(false);
        expect('trust' in opts).toBe(false);
        expect('trustedDirectories' in opts).toBe(false);
        expect('bareRepositories' in opts).toBe(false);
      } finally {
        await repo.dispose();
      }
    });
  });
});

describe('Given gitDir, trust, trustedDirectories, and bareRepositories are all explicitly set', () => {
  describe('When openRepository runs', () => {
    it('Then each reaches resolveLayout as a present key with the forwarded value', async () => {
      // Arrange
      const sut = openRepository;
      const explicitGitDir = path.join(tmpdir, 'custom.git');
      const trusted = path.join(tmpdir, 'trusted-dir');
      await mkdir(trusted, { recursive: true });

      // Act
      const repo = await sut({
        cwd: tmpdir,
        gitDir: explicitGitDir,
        trust: 'always',
        trustedDirectories: [trusted],
        bareRepositories: 'explicit',
      });

      try {
        const opts = capturedOpts();

        // Assert
        expect(opts.gitDir).toBe(explicitGitDir);
        expect(opts.trust).toBe('always');
        expect('trustedDirectories' in opts).toBe(true);
        expect(opts.bareRepositories).toBe('explicit');
      } finally {
        await repo.dispose();
      }
    });
  });
});
