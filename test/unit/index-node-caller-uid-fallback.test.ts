/**
 * Unit coverage for the Node shim's caller-uid fallback
 * (`src/index.node.ts`, the `nodeLayoutProbe.isOwnedByCaller` closure):
 * `process.geteuid?.() ?? process.getuid?.()` feeds `ownedByCallerPredicate`
 * as the trust gate's caller identity. Only the EFFECTIVE uid is the port
 * contract (git's own `geteuid()` — see the inline comment on that line); a
 * `&&` mutant would silently substitute the REAL uid instead whenever the
 * effective uid is a truthy, non-zero number — the ordinary (non-root,
 * non-setuid) case `??` and `&&` disagree on:
 *
 *   `geteuid() ?? getuid()` never calls `getuid` once `geteuid` returns a
 *   defined value (even `0`, which is non-nullish); `geteuid() && getuid()`
 *   calls `getuid` whenever `geteuid` is truthy and returns THAT result
 *   instead. A directory whose real (stat'd) owner matches a stubbed
 *   `geteuid` but NOT a stubbed `getuid` — both stubbed directly, no root or
 *   setuid binary required — separates the two: trusted under `??`,
 *   untrusted under `&&`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SPOOFED_OWNER_UID = 700_007;
const DECOY_UID = 1;

/**
 * `process.geteuid` / `process.getuid` exist only on POSIX, and `vi.spyOn`
 * throws outright on a property the object does not define, so this row cannot
 * run on Windows.
 *
 * Nothing is lost by skipping it there. With both accessors absent,
 * `geteuid?.() ?? getuid?.()` and the `&&` form BOTH evaluate to `undefined`,
 * so the very distinction this row exists to pin is unobservable on Windows —
 * and the ownership gate is POSIX-only by design, treating an undeterminable
 * caller identity as "no foreign ownership can be proven here".
 */
const POSIX_UID_ACCESSORS =
  typeof process.geteuid === 'function' && typeof process.getuid === 'function';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (path: Parameters<typeof actual.stat>[0]) => {
      const result = await actual.stat(path);
      result.uid = SPOOFED_OWNER_UID;
      return result;
    }),
  };
});

const { openRepository } = await import('../../src/index.node.js');

let tmpdir: string;

beforeEach(async () => {
  tmpdir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-node-caller-uid-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpdir, { recursive: true, force: true });
});

const makeGitDir = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'refs'), { recursive: true });
  await writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
};

describe.skipIf(!POSIX_UID_ACCESSORS)(
  'Given a repository whose stat-reported owner matches the stubbed effective uid but not the stubbed real uid',
  () => {
    describe('When openRepository evaluates the ownership-trust gate', () => {
      it('Then ownership is judged against process.geteuid, never process.getuid', async () => {
        // Arrange
        await makeGitDir(path.join(tmpdir, '.git'));
        const geteuidSpy = vi.spyOn(process, 'geteuid').mockReturnValue(SPOOFED_OWNER_UID);
        const getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(DECOY_UID);
        const sut = openRepository;

        // Act
        const repo = await sut({ cwd: tmpdir });

        try {
          // Assert — the effective uid matched the stat'd owner, so the trust
          // gate accepted; the real uid (getuid) was never even consulted.
          expect(repo.ctx.layout.untrusted).toBeUndefined();
          expect(getuidSpy).not.toHaveBeenCalled();
          expect(geteuidSpy).toHaveBeenCalled();
        } finally {
          await repo.dispose();
        }
      });
    });
  },
);
