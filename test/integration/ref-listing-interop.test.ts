/**
 * Cross-tool interop — ref enumeration over symbolic refs whose chain does
 * not resolve for reading. One shared base is built with canonical git and
 * planted with an over-deep symref chain, a dangling symref and a symref
 * loop, under `refs/heads/` and `refs/tags/` alike; every row compares the
 * names `git branch` / `git tag -l` print against the names tsgit's
 * `branchList` / `tagList` return.
 *
 * @proves
 *   surface:        branchList
 *   bucket:         cross-tool-interop
 *   unique:         branch and tag listings drop a chain git's own iterator drops
 *   interopSurface: branchList
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchList } from '../../src/application/commands/branch.js';
import { tagList } from '../../src/application/commands/tag.js';
import type { RefName } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import { disableAutoMaintenance, GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

/** One hop past git's five-read symref walk. */
const OVER_DEEP_HOPS = 5;

describe.skipIf(!GIT_AVAILABLE)('integration — ref listing parity with canonical git', () => {
  let base = '';
  let ctx: Context;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-listing-interop-'));
    runGit(['init', '-q', '-b', 'main', base]);
    git(base, 'config', 'user.name', 'A');
    git(base, 'config', 'user.email', 'a@x');
    git(base, 'config', 'commit.gpgsign', 'false');
    git(base, 'config', 'tag.gpgsign', 'false');
    disableAutoMaintenance(base);
    await writeFile(path.join(base, 'f.txt'), 'c1\n');
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '-m', 'c1');
    git(base, 'tag', 'plain');

    // A chain of symrefs ending on a real branch: `chain0` needs one read
    // more than git takes, `chain1` exactly as many as it takes.
    git(base, 'branch', 'tip', 'main');
    for (let step = OVER_DEEP_HOPS - 1; step >= 0; step -= 1) {
      const target = step === OVER_DEEP_HOPS - 1 ? 'tip' : `chain${step + 1}`;
      git(base, 'symbolic-ref', `refs/heads/chain${step}`, `refs/heads/${target}`);
    }
    git(base, 'symbolic-ref', 'refs/tags/deep', 'refs/heads/chain0');
    git(base, 'symbolic-ref', 'refs/heads/dang', 'refs/heads/gone');
    // A loop, written directly: `symbolic-ref` builds one hop at a time and
    // the second hop would close the cycle on a name it must first read.
    await writeFile(path.join(base, '.git', 'refs', 'heads', 'cyc1'), 'ref: refs/heads/cyc2\n');
    await writeFile(path.join(base, '.git', 'refs', 'heads', 'cyc2'), 'ref: refs/heads/cyc1\n');

    ctx = createNodeContext({ workDir: base });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const gitNames = (prefix: string, ...args: ReadonlyArray<string>): ReadonlyArray<string> =>
    git(base, ...args)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `${prefix}${line}`)
      .sort();

  describe('Given branch symrefs that are over-deep, dangling and looping', () => {
    describe('When both tools list branches', () => {
      it('Then they name exactly the same branches', async () => {
        // Arrange
        const expected = gitNames('', 'branch', '--format=%(refname)');

        // Act
        const { branches } = await branchList(ctx);

        // Assert
        expect(branches.map((branch) => branch.name as string).sort()).toEqual(expected);
        expect(expected).not.toContain('refs/heads/chain0');
        expect(expected).not.toContain('refs/heads/dang');
        expect(expected).not.toContain('refs/heads/cyc1');
        expect(expected).toContain('refs/heads/chain1');
      });
    });

    describe('When both tools report the tip value of the deepest readable chain', () => {
      it('Then they agree on its object id', async () => {
        // Arrange
        const expected = git(base, 'rev-parse', 'refs/heads/chain1').trim();

        // Act
        const { branches } = await branchList(ctx);

        // Assert
        const chain = branches.find((branch) => branch.name === ('refs/heads/chain1' as RefName));
        expect(chain?.id).toBe(expected);
      });
    });
  });

  describe('Given a tag symref whose chain runs past the reading walk', () => {
    describe('When both tools list tags', () => {
      it('Then they name exactly the same tags', async () => {
        // Arrange
        const expected = gitNames('refs/tags/', 'tag', '-l');

        // Act
        const { tags } = await tagList(ctx);

        // Assert
        expect(tags.map((tag) => tag.name as string).sort()).toEqual(expected);
        expect(expected).not.toContain('refs/tags/deep');
        expect(expected).toContain('refs/tags/plain');
      });
    });
  });
});
