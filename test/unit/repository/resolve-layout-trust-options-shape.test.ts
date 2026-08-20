import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';

// `resolveLayout` builds the `TrustOptions` object it hands to `evaluateTrust`
// from three independent `opts.X !== undefined ? { X: opts.X } : {}` spreads
// (see `resolve-layout.ts`). Every consumer of that object only ever reads a
// named property (`.trust`, `.trustedDirectories ?? []`, `.bareRepositories`),
// so an omitted key and a key explicitly set to `undefined` are unobservable
// through property access alone — `evaluateTrust` itself cannot tell them
// apart. `evaluateTrust` has no dependency-injection seam for its 4th
// argument (`resolve-layout.ts` imports it directly), so — mirroring the
// `node:fs/promises` `realpath` spy in
// `index-node-root-canonicalisation.test.ts`, the codebase's own precedent
// for exactly this situation — the ONLY way to observe the object's actual
// SHAPE (own keys, not just values) is to spy on the call and inspect the
// captured argument with `toStrictEqual`, which — unlike `toEqual` — treats
// an own property explicitly set to `undefined` as distinct from an absent
// key.
vi.mock('../../../src/repository/trust-verdict.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/repository/trust-verdict.js')>();
  return { ...actual, evaluateTrust: vi.fn(actual.evaluateTrust) };
});

const { evaluateTrust } = await import('../../../src/repository/trust-verdict.js');
const { resolveLayout } = await import('../../../src/repository/resolve-layout.js');

const evaluateTrustSpy = vi.mocked(evaluateTrust);

/** Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD` file. */
const makeGitDir = async (fs: MemoryFileSystem, dir: string): Promise<void> => {
  await fs.mkdir(`${dir}/objects`);
  await fs.mkdir(`${dir}/refs`);
  await fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
};

beforeEach(() => {
  evaluateTrustSpy.mockClear();
});

describe('resolveLayout — the constructed TrustOptions object shape', () => {
  describe('Given none of trust, trustedDirectories, or bareRepositories are set', () => {
    describe('When resolveLayout runs a gated (non-EXPLICIT) route', () => {
      it('Then evaluateTrust receives an object with no own keys at all', async () => {
        // Arrange
        const fs = new MemoryFileSystem({ rootDir: '/repo' });
        await makeGitDir(fs, '/repo/bare.git');

        // Act
        await resolveLayout(fileSystemLayoutProbe(fs), '/repo/bare.git', posixPolicy);

        // Assert — a mutant forcing any one of the three `!== undefined`
        // guards to `true` would spread in that key with value `undefined`,
        // which `toStrictEqual` (unlike `toEqual`) does NOT treat as `{}`.
        expect(evaluateTrustSpy).toHaveBeenCalledTimes(1);
        expect(evaluateTrustSpy.mock.calls[0]?.[3]).toStrictEqual({});
      });
    });
  });
});
