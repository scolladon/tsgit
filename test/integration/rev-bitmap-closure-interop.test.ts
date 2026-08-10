/**
 * Cross-tool interop — pins the shared closure engine's WALK tier (Parts
 * 9-10) against real git before the bitmap tier (Part 12+) exists to be
 * verified against it. An unpinned oracle is not an oracle: every later
 * bitmap-tier row compares tsgit's bitmap answer to tsgit's OWN walk
 * answer, so the walk answer must itself be proven to match canonical git
 * first.
 *
 * `gitObjectSet`/`tsgitObjectSet`/`assertSameSet` are shaped for a second
 * caller (Part 15 extends this suite to the bitmap tier): `named` is the
 * TIER DETECTOR — a bitmap answer carries no names at all, so a later row
 * distinguishes "walk answered" from "bitmap answered" by checking whether
 * `named` is zero. Every comparison here is a SET comparison on ids —
 * `git rev-list`'s own order (and tsgit's) is deterministic but not
 * equal to the other's, and is never asserted.
 *
 * @proves
 *   surface:        revList
 *   bucket:         cross-tool-interop
 *   unique:         rev-list closures match canonical git on both tiers
 *   interopSurface: closure
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { RevListResult } from '../../src/application/commands/rev-list.js';
import { revList } from '../../src/application/commands/rev-list.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git } from './interop-helpers.js';
import {
  addLooseCommitAboveF2,
  buildF2ClosureFixture,
  buildF4ClosureFixture,
  buildF5ClosureFixture,
  type ClosureFixture,
} from './rev-bitmap-closure-fixtures.js';

// ---------------------------------------------------------------------------
// Shared helpers — shaped for a second caller (Part 15's bitmap-tier suite).
// ---------------------------------------------------------------------------

interface ObjectSet {
  readonly ids: ReadonlySet<string>;
  /** Count of lines/entries carrying a NON-EMPTY name. A bitmap answer
   *  carries none; a root tree's own (empty-string) path does not count
   *  either — only an actual path does. */
  readonly named: number;
}

/** Parses `git rev-list <args>` stdout: one id per line, optionally
 *  followed by a space and a name (a path for `--objects`' trees/blobs, or
 *  a ref name for a tag reached via `--all`). */
function gitObjectSet(dir: string, ...args: ReadonlyArray<string>): ObjectSet {
  const stdout = git(dir, 'rev-list', ...args);
  const ids = new Set<string>();
  let named = 0;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const spaceIndex = line.indexOf(' ');
    if (spaceIndex === -1) {
      ids.add(line);
      continue;
    }
    ids.add(line.slice(0, spaceIndex));
    if (line.length > spaceIndex + 1) named += 1;
  }
  return { ids, named };
}

/** Same shape as `gitObjectSet`, from a `RevListResult` — an entry is
 *  "named" when it carries a non-empty `path` (a root tree's own empty-string
 *  path does not count, matching `gitObjectSet`'s definition exactly). */
function tsgitObjectSet(result: RevListResult): ObjectSet {
  const ids = new Set(result.entries.map((entry) => entry.id));
  const named = result.entries.filter(
    (entry) => entry.path !== undefined && entry.path.length > 0,
  ).length;
  return { ids, named };
}

/** Set equality on ids only — never order. `toEqual` on two sorted arrays
 *  gives a readable diff on failure without asserting either side's order. */
function assertSameSet(actual: ReadonlySet<string>, expected: ReadonlySet<string>): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}

// Every Context this suite builds is disposed after its row — packed reads
// open persistent FileHandles, and an undisposed registry surfaces as the
// GC-close warning the handle-lifecycle work treats as its leak oracle.
const liveContexts: Context[] = [];
function trackedNodeContext(workDir: string): Context {
  const ctx = createNodeContext({ workDir });
  liveContexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('rev-list walk closures match canonical git', () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function newRoot(slug: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-rev-bitmap-closure-${slug}-`));
    roots.push(dir);
    return dir;
  }

  // ---------------------------------------------------------------------
  // F2 — 400 commits, one branch, one annotated tag
  // ---------------------------------------------------------------------

  describe('Given F2 (400 commits, one branch, one annotated tag)', () => {
    let f2: ClosureFixture;

    beforeAll(async () => {
      f2 = await buildF2ClosureFixture(await newRoot('f2'), 'repo');
    }, 60_000);

    describe("When the named detector parses git's own --objects HEAD output (control)", () => {
      it('Then it counts exactly 805 non-empty-named lines', () => {
        // Arrange
        const sut = gitObjectSet;

        // Act
        const result = sut(f2.dir, '--objects', 'HEAD');

        // Assert
        expect(result.named).toBe(805);
      });
    });

    describe('When revList runs with objects: true over --all (control)', () => {
      it('Then the id set matches git --objects --all exactly (1606)', async () => {
        // Arrange
        const gitSet = gitObjectSet(f2.dir, '--objects', '--all');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), { all: true, objects: true });

        // Assert — this is ALSO the `--all` option-composition row: tsgit's
        // `all` unions the tag's peeled tip with HEAD's, same as git's own.
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(1606);
      });
    });

    describe('When revList runs with objects: true over HEAD', () => {
      it('Then the id set matches git --objects HEAD exactly (1605)', async () => {
        // Arrange
        const gitSet = gitObjectSet(f2.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), { wants: ['HEAD'], objects: true });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(1605);
      });
    });

    describe('When revList runs over HEAD with no objects option (commits only)', () => {
      it('Then the id set matches plain git rev-list HEAD exactly (400 commits)', async () => {
        // Arrange
        const gitSet = gitObjectSet(f2.dir, 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), { wants: ['HEAD'] });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(400);
      });
    });

    describe('When revList runs over HEAD with and without objects', () => {
      it('Then count tracks entries.length and moves from 400 to 1605 with objects: true', async () => {
        // Arrange
        const sut = revList;

        // Act
        const withoutObjects = await sut(trackedNodeContext(f2.dir), { wants: ['HEAD'] });
        const withObjects = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          objects: true,
        });

        // Assert
        expect(withoutObjects.count).toBe(withoutObjects.entries.length);
        expect(withoutObjects.count).toBe(400);
        expect(withObjects.count).toBe(withObjects.entries.length);
        expect(withObjects.count).toBe(1605);
      });
    });

    describe('When revList runs with a have boundary (HEAD --not HEAD~50), against plain git rev-list', () => {
      it('Then the id set matches exactly (204 objects)', async () => {
        // Arrange
        const gitSet = gitObjectSet(f2.dir, '--objects', 'HEAD', '--not', 'HEAD~50');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          not: ['HEAD~50'],
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(204);
      });
    });

    describe('When the have-bearing walk is compared to the exact set difference', () => {
      it('Then the walk over-reports a non-empty set, and every extra object is independently reachable from the not tip', () => {
        // Arrange
        const headSet = gitObjectSet(f2.dir, '--objects', 'HEAD');
        const notTipSet = gitObjectSet(f2.dir, '--objects', 'HEAD~50');
        const walkSet = gitObjectSet(f2.dir, '--objects', 'HEAD', '--not', 'HEAD~50');

        // Act
        const exactDifference = new Set([...headSet.ids].filter((id) => !notTipSet.ids.has(id)));
        const overReport = [...walkSet.ids].filter((id) => !exactDifference.has(id));

        // Assert — the difference is real, not vacuous.
        expect(overReport.length).toBeGreaterThan(0);
        // Assert — every extra object is reachable from the not tip alone,
        // proven by an INDEPENDENT `git rev-list --objects <not-tip>` call.
        for (const id of overReport) {
          expect(notTipSet.ids.has(id)).toBe(true);
        }
      });
    });

    describe('When revList runs with maxCount: 10, against git --max-count=10', () => {
      it('Then both the commit count and the object count match exactly (10 commits / 435 objects)', async () => {
        // Arrange
        const gitCommits = gitObjectSet(f2.dir, '--max-count=10', 'HEAD');
        const gitObjects = gitObjectSet(f2.dir, '--max-count=10', '--objects', 'HEAD');
        const sut = revList;

        // Act
        const commitsOnly = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          maxCount: 10,
        });
        const withObjects = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          maxCount: 10,
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(commitsOnly).ids, gitCommits.ids);
        expect(commitsOnly.count).toBe(10);
        assertSameSet(tsgitObjectSet(withObjects).ids, gitObjects.ids);
        expect(withObjects.count).toBe(435);
      });
    });

    describe('When a loose commit is added on top and revList runs over the new HEAD', () => {
      it('Then the id set matches git exactly and grows by 3 loose objects (1608)', async () => {
        // Arrange
        await addLooseCommitAboveF2(f2.dir);
        const gitSet = gitObjectSet(f2.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(1608);
      });
    });
  });

  // ---------------------------------------------------------------------
  // F5 — 120 commits, flattened, small enough to enumerate by hand
  // ---------------------------------------------------------------------

  describe('Given F5 (120 commits, flattened, recurring shared-file content)', () => {
    let f5: ClosureFixture;

    beforeAll(async () => {
      f5 = await buildF5ClosureFixture(await newRoot('f5'), 'repo');
    }, 60_000);

    describe('When revList runs with objects: true over HEAD', () => {
      it('Then the id set matches git --objects HEAD exactly (367 objects)', async () => {
        // Arrange
        const gitSet = gitObjectSet(f5.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f5.dir), { wants: ['HEAD'], objects: true });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(367);
      });
    });

    describe("When the walk tier's path-carrying count is compared to git's own name-carrying line count", () => {
      it('Then both count exactly 127', async () => {
        // Arrange
        const gitSet = gitObjectSet(f5.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f5.dir), { wants: ['HEAD'], objects: true });

        // Assert
        expect(tsgitObjectSet(result).named).toBe(gitSet.named);
        expect(tsgitObjectSet(result).named).toBe(127);
      });
    });

    describe('When revList runs with a have boundary (HEAD --not HEAD~50), against plain git rev-list', () => {
      it('Then the id set matches exactly (156 objects)', async () => {
        // Arrange
        const gitSet = gitObjectSet(f5.dir, '--objects', 'HEAD', '--not', 'HEAD~50');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f5.dir), {
          wants: ['HEAD'],
          not: ['HEAD~50'],
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(156);
      });
    });

    describe('When the have-bearing walk is compared to the exact set difference', () => {
      it('Then the walk over-reports a non-empty set, and every extra object is independently reachable from the not tip', () => {
        // Arrange
        const headSet = gitObjectSet(f5.dir, '--objects', 'HEAD');
        const notTipSet = gitObjectSet(f5.dir, '--objects', 'HEAD~50');
        const walkSet = gitObjectSet(f5.dir, '--objects', 'HEAD', '--not', 'HEAD~50');

        // Act
        const exactDifference = new Set([...headSet.ids].filter((id) => !notTipSet.ids.has(id)));
        const overReport = [...walkSet.ids].filter((id) => !exactDifference.has(id));

        // Assert
        expect(overReport.length).toBeGreaterThan(0);
        for (const id of overReport) {
          expect(notTipSet.ids.has(id)).toBe(true);
        }
      });
    });
  });

  // ---------------------------------------------------------------------
  // F4 — 76 commits including one real merge
  // ---------------------------------------------------------------------

  describe('Given F4 (76 commits including one real merge of topic into main)', () => {
    let f4: ClosureFixture;

    beforeAll(async () => {
      f4 = await buildF4ClosureFixture(await newRoot('f4'), 'repo');
    }, 60_000);

    describe('When revList runs with a have boundary (HEAD --not topic), against plain git rev-list', () => {
      it('Then the id set matches exactly (179 objects) — on a MERGE fixture, unlike a linear one', async () => {
        // Arrange
        const gitSet = gitObjectSet(f4.dir, '--objects', 'HEAD', '--not', 'topic');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD'],
          not: ['topic'],
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(179);
      });
    });

    describe('When revList runs with firstParent: true, against git --first-parent', () => {
      it('Then both the commit count and the object count match exactly (61 commits / 184 objects)', async () => {
        // Arrange — first-parent only "looks correct whatever the
        // implementation does" on a linear fixture; this is the merge
        // fixture the design calls for measuring it on.
        const gitCommits = gitObjectSet(f4.dir, '--first-parent', 'HEAD');
        const gitObjects = gitObjectSet(f4.dir, '--first-parent', '--objects', 'HEAD');
        const sut = revList;

        // Act
        const commitsOnly = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD'],
          firstParent: true,
        });
        const withObjects = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD'],
          firstParent: true,
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(commitsOnly).ids, gitCommits.ids);
        expect(commitsOnly.count).toBe(61);
        assertSameSet(tsgitObjectSet(withObjects).ids, gitObjects.ids);
        expect(withObjects.count).toBe(184);
      });
    });

    describe('When revList runs with noWalk: true over both branch tips, against git --no-walk', () => {
      it('Then both the commit count and the object count match exactly (2 commits / 7 objects)', async () => {
        // Arrange — the merge fixture: HEAD (the merge commit) and topic
        // resolve to two DIFFERENT commits, so --no-walk's "seeds only, no
        // parent traversal" is exercised on more than a single tip.
        const gitCommits = gitObjectSet(f4.dir, '--no-walk', 'HEAD', 'topic');
        const gitObjects = gitObjectSet(f4.dir, '--no-walk', '--objects', 'HEAD', 'topic');
        const sut = revList;

        // Act
        const commitsOnly = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD', 'topic'],
          noWalk: true,
        });
        const withObjects = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD', 'topic'],
          noWalk: true,
          objects: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(commitsOnly).ids, gitCommits.ids);
        expect(commitsOnly.count).toBe(2);
        assertSameSet(tsgitObjectSet(withObjects).ids, gitObjects.ids);
        expect(withObjects.count).toBe(7);
      });
    });
  });
});
