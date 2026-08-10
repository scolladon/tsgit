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
 * **The bitmap tier.** This suite is a SECURITY CONTROL, not
 * hygiene: the bitmap is trusted on the read path by deliberate decision,
 * range validation is the first line, and this suite is the second —
 * neither may be trimmed. Every closure row below asserts the SAME
 * cross-tier invariant, on object id and type only, never on `path`:
 *
 *   1. `not` empty      => the two tiers return EXACTLY the same set;
 *   2. `not` non-empty  => `bitmapSet ⊂ walkSet`, AND every object in
 *      `walkSet \ bitmapSet` is reachable from a `not` tip — proven by an
 *      INDEPENDENT full `git rev-list --objects <not-tip>` closure, never
 *      by inspection. This is the clause a fixture with no repeated blob
 *      content passes VACUOUSLY (the difference degenerates to equality),
 *      so it is asserted NON-EMPTY only on F2 and F5, which carry the
 *      recurring-content property (module doc, `rev-bitmap-closure-
 *      fixtures.ts`) the vacuous case would otherwise hide behind.
 *
 * **The double run.** The core set-correctness rows (F2 and F5's
 * set-equality and have-bearing rows) run TWICE: once against a fixture
 * carrying a bitmap, once against the SAME repository with every `.bitmap`
 * file removed (forcing the silent walk fallback). Together with the walk
 * oracle every row here already runs against, this is the only thing
 * standing between a decoder bug that produces a plausible but WRONG
 * answer and a wrong pack — a bug confined to the decoder has nowhere to
 * hide if removing the artefact it decodes does not change the answer.
 *
 * @proves
 *   surface:        revList
 *   bucket:         cross-tool-interop
 *   unique:         rev-list closures match canonical git on both tiers
 *   interopSurface: closure
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import type { RevListResult } from '../../src/application/commands/rev-list.js';
import { revList } from '../../src/application/commands/rev-list.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { parsePackIndex } from '../../src/domain/storage/index.js';
// `allObjectIds` is not barrel-exported — imported directly, as
// `pack-bitmap-binding.ts` already does.
import { allObjectIds } from '../../src/domain/storage/pack-index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import {
  addLooseCommitAboveF2,
  buildF2ClosureFixture,
  buildF3ClosureFixture,
  buildF4ClosureFixture,
  buildF5ClosureFixture,
  buildF6ClosureFixture,
  type ClosureFixture,
  clearFullDagFlagAndRestamp,
  type F3ClosureFixture,
  type F6ClosureFixture,
} from './rev-bitmap-closure-fixtures.js';
import {
  buildBitmapFixture,
  mutateOrThrow,
  packArtefactPathsNamed,
  restampBitmap,
} from './rev-bitmap-fixture-helpers.js';

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
/** Same tracking, wrapped with a `warn` spy — the pack registry is cached
 *  by CONTEXT IDENTITY (a `WeakMap<Context, PackRegistry>`), so the wrapper
 *  object itself — not the bare context underneath it — is what must be
 *  tracked for disposal, or its own lazily-created registry leaks a
 *  FileHandle no `afterEach` ever closes. */
function trackedNodeContextWithWarnSpy(
  workDir: string,
  warn: (...args: unknown[]) => void,
): Context {
  const wrapped: Context = { ...createNodeContext({ workDir }), logger: { warn } };
  liveContexts.push(wrapped);
  return wrapped;
}
afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
});

/**
 * Copies `sourceDir`'s whole `.git` state into `targetDir` and strips every
 * pack-directory file ending in `suffix` from the copy. Copies rather than
 * mutating a shared fixture in place: F2 and F5 are built once per file in
 * a shared `beforeAll` and reused across many rows, so stripping an
 * artefact from the ORIGINAL would leave every row declared after this one
 * running against a broken fixture.
 */
async function fixtureWithoutArtefactSuffix(
  sourceDir: string,
  targetDir: string,
  suffix: string,
): Promise<string> {
  await cp(sourceDir, targetDir, { recursive: true });
  const packDir = path.join(targetDir, '.git', 'objects', 'pack');
  for (const name of await readdir(packDir)) {
    if (name.endsWith(suffix)) await rm(path.join(packDir, name));
  }
  return targetDir;
}

/** Every `.bitmap` stripped — the double run's OTHER half (module doc):
 *  forces the bitmap request to fall silently back to the walk. */
async function fixtureWithoutBitmap(sourceDir: string, targetDir: string): Promise<string> {
  return fixtureWithoutArtefactSuffix(sourceDir, targetDir, '.bitmap');
}

/** Plain recursive copy, no stripping — F3's artefact-preference rows each
 *  need their OWN disposable copy, since the detector (`gitAborts`) is
 *  destructive (it corrupts a `.bitmap` beyond recovery) and F3 is a
 *  shared `beforeAll` fixture reused across every row in its own describe. */
async function copyFixture(sourceDir: string, targetDir: string): Promise<string> {
  await cp(sourceDir, targetDir, { recursive: true });
  return targetDir;
}

/**
 * Runs `git <args>` directly via `spawnSync` — bypassing `tryRunGitWithExit`,
 * which folds a signal-terminated process's `status: null` down to a fake
 * `1` — and reports whether it was killed by `SIGABRT`: canonical git's own
 * crash signature (a shell reports this as exit 134) the instant it LOADS a
 * bitmap missing `BITMAP_OPT_FULL_DAG`. The only clean way, from outside
 * the process, to prove WHICH of two present bitmaps git actually opened —
 * the artefact-preference rows depend on it.
 */
function gitAborts(dir: string, ...args: string[]): boolean {
  const result = spawnSync('git', ['-C', dir, ...args], { env: runGitEnv(), encoding: 'utf8' });
  return result.signal === 'SIGABRT';
}

/** `git cat-file --batch-check` over a newline-joined id list — the
 *  cross-tool type oracle the "type correctness" row checks the bitmap
 *  tier's own `type` field against. */
function gitObjectTypes(dir: string, ids: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const stdout = runGit(['-C', dir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: ids.join('\n'),
    env: runGitEnv(),
  });
  const types = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const [id, type] = line.split(' ');
    if (id !== undefined && type !== undefined) types.set(id, type);
  }
  return types;
}

/** Reads a `.idx`'s own object-id set back — the "read back from the
 *  `.idx`" proof the pack-objects rows require, never a `packId` compare:
 *  object order (and so the pack's own checksum) differs between tiers even
 *  for the identical closure. */
async function idxObjectIds(idxPath: string): Promise<ReadonlySet<string>> {
  const bytes = await readFile(idxPath);
  const index = parsePackIndex(bytes);
  return new Set(allObjectIds(index));
}

function findingsOfType<T extends FsckFinding['type']>(
  findings: ReadonlyArray<FsckFinding>,
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> {
  return findings.filter(
    (finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type,
  );
}

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

    // -----------------------------------------------------------------
    // Bitmap tier — the double run's F2 half (module doc).
    // -----------------------------------------------------------------

    describe(
      'When revList runs bitmap-tier over HEAD, WITH the artefact present and then WITH it ' +
        'removed (the double-run + walk-oracle obligation — together the only guard against a ' +
        'decoder bug producing a wrong pack)',
      () => {
        it('Then both runs match git --objects HEAD exactly (1605) and carry no path', async () => {
          // Arrange
          const gitSet = gitObjectSet(f2.dir, '--objects', 'HEAD');
          const noBitmapDir = await fixtureWithoutBitmap(
            f2.dir,
            await newRoot('f2-no-bitmap-head'),
          );
          const sut = revList;

          // Act
          const withArtefact = await sut(trackedNodeContext(f2.dir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });
          const withoutArtefact = await sut(trackedNodeContext(noBitmapDir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });

          // Assert
          assertSameSet(tsgitObjectSet(withArtefact).ids, gitSet.ids);
          expect(withArtefact.count).toBe(1605);
          expect(tsgitObjectSet(withArtefact).named).toBe(0);
          assertSameSet(tsgitObjectSet(withoutArtefact).ids, gitSet.ids);
          expect(withoutArtefact.count).toBe(1605);
        });
      },
    );

    describe(
      'When revList runs bitmap-tier over a want with NO direct bitmap entry (HEAD~295), WITH ' +
        'the artefact present and then WITH it removed (the double-run + walk-oracle obligation)',
      () => {
        it('Then both runs match git --objects HEAD~295 exactly (425) and carry no path', async () => {
          // Arrange — HEAD~295 is one of the ~292 commits git's bitmap
          // writer gave no direct entry to (only 108 of F2's 400 commits
          // have one); the artefact still answers it correctly, through the
          // fallback walk INSIDE the bitmap tier rather than a direct
          // reconstruction.
          const gitSet = gitObjectSet(f2.dir, '--objects', 'HEAD~295');
          const noBitmapDir = await fixtureWithoutBitmap(
            f2.dir,
            await newRoot('f2-no-bitmap-non-entry'),
          );
          const sut = revList;

          // Act
          const withArtefact = await sut(trackedNodeContext(f2.dir), {
            wants: ['HEAD~295'],
            objects: true,
            useBitmapIndex: true,
          });
          const withoutArtefact = await sut(trackedNodeContext(noBitmapDir), {
            wants: ['HEAD~295'],
            objects: true,
            useBitmapIndex: true,
          });

          // Assert
          assertSameSet(tsgitObjectSet(withArtefact).ids, gitSet.ids);
          expect(withArtefact.count).toBe(425);
          expect(tsgitObjectSet(withArtefact).named).toBe(0);
          assertSameSet(tsgitObjectSet(withoutArtefact).ids, gitSet.ids);
          expect(withoutArtefact.count).toBe(425);
        });
      },
    );

    describe(
      'When revList runs bitmap-tier with a have boundary (HEAD --not HEAD~50), WITH the ' +
        'artefact present and then WITH it removed (the double-run + walk-oracle obligation)',
      () => {
        it(
          'Then the artefact answers the EXACT set difference (200), a proper subset of the ' +
            'walk (204), and every walk-only object is independently reachable from the not tip',
          async () => {
            // Arrange
            const gitBitmapSet = gitObjectSet(
              f2.dir,
              '--use-bitmap-index',
              '--objects',
              'HEAD',
              '--not',
              'HEAD~50',
            );
            const gitWalkSet = gitObjectSet(f2.dir, '--objects', 'HEAD', '--not', 'HEAD~50');
            const notTipSet = gitObjectSet(f2.dir, '--objects', 'HEAD~50');
            const noBitmapDir = await fixtureWithoutBitmap(
              f2.dir,
              await newRoot('f2-no-bitmap-have-bearing'),
            );
            const sut = revList;

            // Act
            const withArtefact = await sut(trackedNodeContext(f2.dir), {
              wants: ['HEAD'],
              not: ['HEAD~50'],
              objects: true,
              useBitmapIndex: true,
            });
            const withoutArtefact = await sut(trackedNodeContext(noBitmapDir), {
              wants: ['HEAD'],
              not: ['HEAD~50'],
              objects: true,
              useBitmapIndex: true,
            });

            // Assert — the bitmap tier matches git's OWN bitmap tier
            // exactly (200), strictly fewer than the walk's own
            // over-report (204, reproduced once the artefact is removed).
            assertSameSet(tsgitObjectSet(withArtefact).ids, gitBitmapSet.ids);
            expect(withArtefact.count).toBe(200);
            assertSameSet(tsgitObjectSet(withoutArtefact).ids, gitWalkSet.ids);
            expect(withoutArtefact.count).toBe(204);

            // Assert — clause 2 of the cross-tier invariant: bitmapSet ⊂
            // walkSet, the difference is NON-EMPTY (never a vacuous
            // subset-that-is-really-equality), and every object the walk
            // added beyond the bitmap is reachable from the not tip alone —
            // proven by an INDEPENDENT full `git rev-list --objects
            // HEAD~50`, never by inspection.
            const bitmapIds = tsgitObjectSet(withArtefact).ids;
            const walkIds = tsgitObjectSet(withoutArtefact).ids;
            for (const id of bitmapIds) {
              expect(walkIds.has(id)).toBe(true);
            }
            const walkOnly = [...walkIds].filter((id) => !bitmapIds.has(id));
            expect(walkOnly.length).toBeGreaterThan(0);
            for (const id of walkOnly) {
              expect(notTipSet.ids.has(id)).toBe(true);
            }
          },
        );
      },
    );

    describe('When revList runs with maxCount: 10 AND useBitmapIndex: true, against git --max-count=10', () => {
      it('Then the bitmap request is declined for maxCount — the object count still matches exactly (435), same as the walk', async () => {
        // Arrange — git itself abandons the bitmap for a bounded count;
        // this is the option-composition proof that tsgit reproduces the
        // decline rather than honouring `useBitmapIndex` regardless.
        const gitObjects = gitObjectSet(f2.dir, '--max-count=10', '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          maxCount: 10,
          objects: true,
          useBitmapIndex: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitObjects.ids);
        expect(result.count).toBe(435);
      });
    });

    describe('When revList runs bitmap-tier over HEAD, and every returned type is checked against git cat-file', () => {
      it('Then every object type matches git cat-file --batch-check exactly, over all 1605 objects', async () => {
        // Arrange
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          objects: true,
          useBitmapIndex: true,
        });
        const gitTypes = gitObjectTypes(
          f2.dir,
          result.entries.map((entry) => entry.id),
        );

        // Assert
        expect(result.count).toBe(1605);
        for (const entry of result.entries) {
          expect(gitTypes.get(entry.id)).toBe(entry.type);
        }
      });
    });

    describe('When a COPY of F2 has its .rev deleted and revList runs bitmap-tier over HEAD', () => {
      it('Then the artefact still answers, same set (1605) — packPositions never needed the .rev on disk', async () => {
        // Arrange
        const noRevDir = await fixtureWithoutArtefactSuffix(
          f2.dir,
          await newRoot('f2-no-rev'),
          '.rev',
        );
        const gitSet = gitObjectSet(noRevDir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(noRevDir), {
          wants: ['HEAD'],
          objects: true,
          useBitmapIndex: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
        expect(result.count).toBe(1605);
      });
    });

    describe('When packObjects runs on F2 with a have boundary (HEAD --not HEAD~50), at both tiers', () => {
      it('Then each tier writes ITS OWN object set (walk 204, bitmap 200), read back from the .idx, and git index-pack --verify accepts both', async () => {
        // Arrange
        const sut = packObjects;

        // Act
        const walkOut = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          not: ['HEAD~50'],
          useBitmapIndex: false,
          outputDirectory: path.join(f2.dir, 'scratch-pack-objects-walk'),
        });
        const bitmapOut = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          not: ['HEAD~50'],
          outputDirectory: path.join(f2.dir, 'scratch-pack-objects-bitmap'),
        });

        // Assert — counts only, never a `packId` compare: object order (and
        // so the pack's own checksum) differs between tiers even for the
        // identical closure, and here the closures are not even identical
        // (haves shrink the bitmap tier's own pack).
        expect(walkOut.objectCount).toBe(204);
        expect(bitmapOut.objectCount).toBe(200);
        const walkIds = await idxObjectIds(
          path.join(f2.dir, 'scratch-pack-objects-walk', `pack-${walkOut.packId}.idx`),
        );
        const bitmapIds = await idxObjectIds(
          path.join(f2.dir, 'scratch-pack-objects-bitmap', `pack-${bitmapOut.packId}.idx`),
        );
        expect(walkIds.size).toBe(204);
        expect(bitmapIds.size).toBe(200);
        const walkVerify = tryRunGitWithExit([
          'index-pack',
          '--verify',
          path.join(f2.dir, 'scratch-pack-objects-walk', `pack-${walkOut.packId}.pack`),
        ]);
        const bitmapVerify = tryRunGitWithExit([
          'index-pack',
          '--verify',
          path.join(f2.dir, 'scratch-pack-objects-bitmap', `pack-${bitmapOut.packId}.pack`),
        ]);
        expect(walkVerify.exitCode).toBe(0);
        expect(bitmapVerify.exitCode).toBe(0);
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

    describe('When revList runs bitmap-tier over the new HEAD after the loose commit was added on top', () => {
      it('Then the artefact still answers the exact walk answer (1608) — the 3 loose objects resolve through the fallback walk', async () => {
        // Arrange — reuses the SAME already-mutated f2.dir from the row
        // above (adding a second loose commit here would double-count it).
        const gitSet = gitObjectSet(f2.dir, '--objects', 'HEAD');
        const sut = revList;

        // Act
        const result = await sut(trackedNodeContext(f2.dir), {
          wants: ['HEAD'],
          objects: true,
          useBitmapIndex: true,
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

    // -----------------------------------------------------------------
    // Bitmap tier — the double run's F5 half (module doc).
    // -----------------------------------------------------------------

    describe(
      'When revList runs bitmap-tier over HEAD, WITH the artefact present and then WITH it ' +
        'removed (the double-run + walk-oracle obligation — together the only guard against a ' +
        'decoder bug producing a wrong pack)',
      () => {
        it('Then both runs match git --objects HEAD exactly (367)', async () => {
          // Arrange
          const gitSet = gitObjectSet(f5.dir, '--objects', 'HEAD');
          const noBitmapDir = await fixtureWithoutBitmap(
            f5.dir,
            await newRoot('f5-no-bitmap-head'),
          );
          const sut = revList;

          // Act
          const withArtefact = await sut(trackedNodeContext(f5.dir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });
          const withoutArtefact = await sut(trackedNodeContext(noBitmapDir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });

          // Assert
          assertSameSet(tsgitObjectSet(withArtefact).ids, gitSet.ids);
          expect(withArtefact.count).toBe(367);
          assertSameSet(tsgitObjectSet(withoutArtefact).ids, gitSet.ids);
          expect(withoutArtefact.count).toBe(367);
        });
      },
    );

    describe("When the bitmap tier's path-carrying count is compared to the walk tier's own", () => {
      it('Then the walk tier carries 127 names (established) and the bitmap tier carries 0 — path presence is tier-determined', async () => {
        // Arrange
        const sut = revList;

        // Act
        const walkResult = await sut(trackedNodeContext(f5.dir), {
          wants: ['HEAD'],
          objects: true,
        });
        const bitmapResult = await sut(trackedNodeContext(f5.dir), {
          wants: ['HEAD'],
          objects: true,
          useBitmapIndex: true,
        });

        // Assert
        expect(tsgitObjectSet(walkResult).named).toBe(127);
        expect(tsgitObjectSet(bitmapResult).named).toBe(0);
      });
    });

    describe(
      'When revList runs bitmap-tier with a have boundary (HEAD --not HEAD~50), WITH the ' +
        'artefact present and then WITH it removed (the double-run + walk-oracle obligation)',
      () => {
        it(
          'Then the artefact answers the EXACT set difference (150), a proper subset of the ' +
            'walk (156), and every walk-only object is independently reachable from the not tip',
          async () => {
            // Arrange
            const gitBitmapSet = gitObjectSet(
              f5.dir,
              '--use-bitmap-index',
              '--objects',
              'HEAD',
              '--not',
              'HEAD~50',
            );
            const gitWalkSet = gitObjectSet(f5.dir, '--objects', 'HEAD', '--not', 'HEAD~50');
            const notTipSet = gitObjectSet(f5.dir, '--objects', 'HEAD~50');
            const noBitmapDir = await fixtureWithoutBitmap(
              f5.dir,
              await newRoot('f5-no-bitmap-have-bearing'),
            );
            const sut = revList;

            // Act
            const withArtefact = await sut(trackedNodeContext(f5.dir), {
              wants: ['HEAD'],
              not: ['HEAD~50'],
              objects: true,
              useBitmapIndex: true,
            });
            const withoutArtefact = await sut(trackedNodeContext(noBitmapDir), {
              wants: ['HEAD'],
              not: ['HEAD~50'],
              objects: true,
              useBitmapIndex: true,
            });

            // Assert
            assertSameSet(tsgitObjectSet(withArtefact).ids, gitBitmapSet.ids);
            expect(withArtefact.count).toBe(150);
            assertSameSet(tsgitObjectSet(withoutArtefact).ids, gitWalkSet.ids);
            expect(withoutArtefact.count).toBe(156);

            // Assert — clause 2 of the cross-tier invariant, same shape as
            // F2's own row above.
            const bitmapIds = tsgitObjectSet(withArtefact).ids;
            const walkIds = tsgitObjectSet(withoutArtefact).ids;
            for (const id of bitmapIds) {
              expect(walkIds.has(id)).toBe(true);
            }
            const walkOnly = [...walkIds].filter((id) => !bitmapIds.has(id));
            expect(walkOnly.length).toBeGreaterThan(0);
            for (const id of walkOnly) {
              expect(notTipSet.ids.has(id)).toBe(true);
            }
          },
        );
      },
    );
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

    // -----------------------------------------------------------------
    // Bitmap tier — option composition. The bitmap tier does not
    // traverse, so `firstParent`/`noWalk` are IGNORED and the full
    // closure (76 commits / 228 objects) comes back regardless — the
    // SAME thing git's own `--use-bitmap-index` does when combined with
    // either flag, on this merge fixture where ignoring them is visibly
    // different from honouring them (61/184, 2/7 — the walk-tier rows
    // established just above).
    // -----------------------------------------------------------------

    describe('When revList runs bitmap-tier with firstParent: true, against git --use-bitmap-index --first-parent', () => {
      it('Then both ignore firstParent and return the FULL closure (76 commits / 228 objects), not the first-parent-only answer (61/184)', async () => {
        // Arrange
        const gitCommits = gitObjectSet(f4.dir, '--use-bitmap-index', '--first-parent', 'HEAD');
        const gitObjects = gitObjectSet(
          f4.dir,
          '--use-bitmap-index',
          '--first-parent',
          '--objects',
          'HEAD',
        );
        const sut = revList;

        // Act
        const commitsOnly = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD'],
          firstParent: true,
          useBitmapIndex: true,
        });
        const withObjects = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD'],
          firstParent: true,
          objects: true,
          useBitmapIndex: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(commitsOnly).ids, gitCommits.ids);
        expect(commitsOnly.count).toBe(76);
        assertSameSet(tsgitObjectSet(withObjects).ids, gitObjects.ids);
        expect(withObjects.count).toBe(228);
      });
    });

    describe('When revList runs bitmap-tier with noWalk: true over both branch tips, against git --use-bitmap-index --no-walk', () => {
      it('Then both ignore noWalk and return the FULL closure (76 commits / 228 objects), not the seeds-only answer (2/7)', async () => {
        // Arrange
        const gitCommits = gitObjectSet(f4.dir, '--use-bitmap-index', '--no-walk', 'HEAD', 'topic');
        const gitObjects = gitObjectSet(
          f4.dir,
          '--use-bitmap-index',
          '--no-walk',
          '--objects',
          'HEAD',
          'topic',
        );
        const sut = revList;

        // Act
        const commitsOnly = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD', 'topic'],
          noWalk: true,
          useBitmapIndex: true,
        });
        const withObjects = await sut(trackedNodeContext(f4.dir), {
          wants: ['HEAD', 'topic'],
          noWalk: true,
          objects: true,
          useBitmapIndex: true,
        });

        // Assert
        assertSameSet(tsgitObjectSet(commitsOnly).ids, gitCommits.ids);
        expect(commitsOnly.count).toBe(76);
        assertSameSet(tsgitObjectSet(withObjects).ids, gitObjects.ids);
        expect(withObjects.count).toBe(228);
      });
    });
  });

  // ---------------------------------------------------------------------
  // F3 — F2 plus 5 more commits across a second pack, plus a midx bitmap.
  // Artefact preference, midx mapping, .rev-free consumption, and
  // completeness beyond a single artefact.
  // ---------------------------------------------------------------------

  describe(
    'Given F3 (F2 plus 5 more commits repacked incrementally into a second pack, plus a ' +
      'multi-pack-index with its own bitmap: 2 packs, 1 pack bitmap, 1 midx bitmap, 1621 midx objects)',
    () => {
      let f3: F3ClosureFixture;

      beforeAll(async () => {
        f3 = await buildF3ClosureFixture(await newRoot('f3'), 'repo');
      }, 90_000);

      describe("When the named detector parses git's own --objects --all / --objects HEAD output (control)", () => {
        it('Then --all counts 1621 and HEAD counts 1620', () => {
          // Arrange
          const sut = gitObjectSet;

          // Act
          const all = sut(f3.dir, '--objects', '--all');
          const head = sut(f3.dir, '--objects', 'HEAD');

          // Assert
          expect(all.ids.size).toBe(1621);
          expect(head.ids.size).toBe(1620);
        });
      });

      describe('When both the midx bitmap and the pack bitmap are healthy', () => {
        it(
          'Then the midx bitmap is the one git loads — corrupting it (a disposable copy) aborts ' +
            'git, corrupting the pack bitmap alone does not — and revList answers HEAD unchanged (1620)',
          async () => {
            // Arrange
            const midxCopy = await copyFixture(f3.dir, await newRoot('f3-detect-midx'));
            const packCopy = await copyFixture(f3.dir, await newRoot('f3-detect-pack'));
            mutateOrThrow(
              path.join(midxCopy, '.git', 'objects', 'pack', path.basename(f3.midxBitmapPath)),
              clearFullDagFlagAndRestamp,
            );
            mutateOrThrow(
              packArtefactPathsNamed(packCopy, f3.bitmapPackName).bitmap,
              clearFullDagFlagAndRestamp,
            );
            const sut = revList;

            // Act
            const midxCorruptedAborts = gitAborts(
              midxCopy,
              'rev-list',
              '--use-bitmap-index',
              '--objects',
              'HEAD',
            );
            const packCorruptedAborts = gitAborts(
              packCopy,
              'rev-list',
              '--use-bitmap-index',
              '--objects',
              'HEAD',
            );
            const result = await sut(trackedNodeContext(f3.dir), {
              wants: ['HEAD'],
              objects: true,
              useBitmapIndex: true,
            });

            // Assert — the detector: git aborts if and only if it LOADED
            // the artefact this row mutated.
            expect(midxCorruptedAborts).toBe(true);
            expect(packCorruptedAborts).toBe(false);
            // Assert — the answer itself is unchanged.
            expect(result.count).toBe(1620);
          },
        );
      });

      describe('When the midx bitmap is deleted (the flat midx file itself stays)', () => {
        it(
          'Then the pack bitmap becomes the one git loads — corrupting it now aborts git — ' +
            'and revList still answers HEAD unchanged (1620)',
          async () => {
            // Arrange
            const answerDir = await copyFixture(
              f3.dir,
              await newRoot('f3-midx-bmp-deleted-answer'),
            );
            await rm(
              path.join(answerDir, '.git', 'objects', 'pack', path.basename(f3.midxBitmapPath)),
            );
            const detectDir = await copyFixture(
              f3.dir,
              await newRoot('f3-midx-bmp-deleted-detect'),
            );
            await rm(
              path.join(detectDir, '.git', 'objects', 'pack', path.basename(f3.midxBitmapPath)),
            );
            mutateOrThrow(
              packArtefactPathsNamed(detectDir, f3.bitmapPackName).bitmap,
              clearFullDagFlagAndRestamp,
            );
            const sut = revList;

            // Act
            const packCorruptedAborts = gitAborts(
              detectDir,
              'rev-list',
              '--use-bitmap-index',
              '--objects',
              'HEAD',
            );
            const result = await sut(trackedNodeContext(answerDir), {
              wants: ['HEAD'],
              objects: true,
              useBitmapIndex: true,
            });

            // Assert
            expect(packCorruptedAborts).toBe(true);
            expect(result.count).toBe(1620);
          },
        );
      });

      describe('When the flat multi-pack-index file itself is deleted (its own bitmap is orphaned)', () => {
        it(
          'Then the pack bitmap becomes the one git loads — corrupting it now aborts git — ' +
            'and revList still answers HEAD unchanged (1620)',
          async () => {
            // Arrange
            const answerDir = await copyFixture(
              f3.dir,
              await newRoot('f3-midx-file-deleted-answer'),
            );
            await rm(path.join(answerDir, '.git', 'objects', 'pack', 'multi-pack-index'));
            const detectDir = await copyFixture(
              f3.dir,
              await newRoot('f3-midx-file-deleted-detect'),
            );
            await rm(path.join(detectDir, '.git', 'objects', 'pack', 'multi-pack-index'));
            mutateOrThrow(
              packArtefactPathsNamed(detectDir, f3.bitmapPackName).bitmap,
              clearFullDagFlagAndRestamp,
            );
            const sut = revList;

            // Act
            const packCorruptedAborts = gitAborts(
              detectDir,
              'rev-list',
              '--use-bitmap-index',
              '--objects',
              'HEAD',
            );
            const result = await sut(trackedNodeContext(answerDir), {
              wants: ['HEAD'],
              objects: true,
              useBitmapIndex: true,
            });

            // Assert
            expect(packCorruptedAborts).toBe(true);
            expect(result.count).toBe(1620);
          },
        );
      });

      describe('When the midx bitmap answers vs when the pack bitmap alone answers (midx bitmap deleted)', () => {
        it('Then both equal each other and equal real git rev-list --objects (1620)', async () => {
          // Arrange
          const gitSet = gitObjectSet(f3.dir, '--objects', 'HEAD');
          const packOnlyDir = await copyFixture(f3.dir, await newRoot('f3-midx-mapping-pack-only'));
          await rm(
            path.join(packOnlyDir, '.git', 'objects', 'pack', path.basename(f3.midxBitmapPath)),
          );
          const sut = revList;

          // Act
          const midxAnswer = await sut(trackedNodeContext(f3.dir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });
          const packAnswer = await sut(trackedNodeContext(packOnlyDir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });

          // Assert
          assertSameSet(tsgitObjectSet(midxAnswer).ids, gitSet.ids);
          assertSameSet(tsgitObjectSet(packAnswer).ids, gitSet.ids);
          expect(midxAnswer.count).toBe(1620);
          expect(packAnswer.count).toBe(1620);
        });
      });

      describe("When the SECOND pack's own .rev is deleted (a copy) and revList runs bitmap-tier over HEAD", () => {
        it('Then the artefact still answers, same set (1620)', async () => {
          // Arrange
          const dir = await copyFixture(f3.dir, await newRoot('f3-no-rev'));
          await rm(packArtefactPathsNamed(dir, f3.plainPackName).rev);
          const gitSet = gitObjectSet(dir, '--objects', 'HEAD');
          const sut = revList;

          // Act
          const result = await sut(trackedNodeContext(dir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });

          // Assert
          assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
          expect(result.count).toBe(1620);
        });
      });

      describe('When the entire midx (flat file AND its own bitmap) is removed and revList runs bitmap-tier over HEAD', () => {
        it(
          "Then the FIRST pack's own bitmap (covering 1606 of the 1621 midx objects) plus the " +
            "fallback walk for the second pack's uncovered objects still answers the exact " +
            "walk's set (1620 = the walk's 1620)",
          async () => {
            // Arrange
            const dir = await copyFixture(f3.dir, await newRoot('f3-completeness'));
            await rm(path.join(dir, '.git', 'objects', 'pack', 'multi-pack-index'));
            await rm(path.join(dir, '.git', 'objects', 'pack', path.basename(f3.midxBitmapPath)));
            const gitSet = gitObjectSet(dir, '--objects', 'HEAD');
            const sut = revList;

            // Act
            const result = await sut(trackedNodeContext(dir), {
              wants: ['HEAD'],
              objects: true,
              useBitmapIndex: true,
            });

            // Assert
            assertSameSet(tsgitObjectSet(result).ids, gitSet.ids);
            expect(result.count).toBe(1620);
          },
        );
      });
    },
  );

  // ---------------------------------------------------------------------
  // F6 — the range-validation family. Unlike every degradation row below,
  // the checksum here is VALID and the fault is a VALUE (an out-of-range
  // entry-header position), not a structure — the one difference that
  // makes the fsck pass and the closure engine disagree, correctly: fsck
  // hashes without parsing, the closure engine parses and declines. This
  // suite is a SECURITY CONTROL, not hygiene — range validation is the
  // first line, this family the second, and neither may be trimmed.
  // ---------------------------------------------------------------------

  describe(
    'Given F6 (40 commits / 120 objects, one pack bitmap whose first per-commit entry header ' +
      'is rewritten to position 999999 and then RESTAMPED)',
    () => {
      let f6: F6ClosureFixture;

      beforeAll(async () => {
        f6 = await buildF6ClosureFixture(await newRoot('f6'), 'repo');
      }, 60_000);

      describe(
        'When git fsck and tsgit.fsck() run over the SAME fixture bytes the consumption row ' +
          'below runs over (fsck HASHES the bitmap without parsing it; the closure engine PARSES ' +
          'it and declines — one file makes both true at once)',
        () => {
          it('Then both exit 0, and tsgit reports no bitmap finding — the checksum is valid, so the fsck pass has nothing to say', async () => {
            // Arrange
            const gitResult = tryRunGitWithExit(['-C', f6.dir, 'fsck']);
            const sut = fsck;

            // Act
            const result = await sut(trackedNodeContext(f6.dir));

            // Assert
            expect(gitResult.exitCode).toBe(0);
            expect(result.exitCode).toBe(0);
            expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
          });
        },
      );

      describe(
        'When git rev-list --use-bitmap-index --objects HEAD runs against revList({ ' +
          'useBitmapIndex: true }) over the SAME fixture bytes the fsck row above runs over — ' +
          'the second line of defence behind range validation, and this suite exists to keep it ' +
          'from ever being trimmed',
        () => {
          it('Then git exits 0 printing the out-of-range error and the walk answer; tsgit returns the walk set, warns ONCE with the artefact name, and surfaces no failure', async () => {
            // Arrange
            const gitResult = tryRunGitWithExit([
              '-C',
              f6.dir,
              'rev-list',
              '--use-bitmap-index',
              '--objects',
              'HEAD',
            ]);
            const warnCalls: unknown[][] = [];
            const sut = revList;

            // Act
            const result = await sut(
              trackedNodeContextWithWarnSpy(f6.dir, (...args) => warnCalls.push(args)),
              { wants: ['HEAD'], objects: true, useBitmapIndex: true },
            );

            // Assert — git's own degradation: exits 0, the out-of-range
            // message on stderr, the WALK's own answer (120) despite trying
            // the bitmap first.
            expect(gitResult.exitCode).toBe(0);
            expect(gitResult.stderr).toContain(
              'corrupt ewah bitmap: commit index 999999 out of range',
            );
            expect(gitResult.stdout.split('\n').filter(Boolean)).toHaveLength(120);
            // Assert — tsgit's own degradation. F6 carries NO `not`, so the
            // two tiers agree on the SET (120) — the warn and git's stderr
            // line are the discriminators here, never the count.
            expect(result.count).toBe(120);
            expect(warnCalls).toHaveLength(1);
            const [message, context] = warnCalls[0] ?? [];
            expect(String(message)).toContain('out of range');
            expect((context as { bitmap?: string }).bitmap).toBe(path.basename(f6.bitmap.bitmap));
          });
        },
      );

      describe('When git rev-list --test-bitmap HEAD runs (git-only: tsgit exposes no --test-bitmap surface)', () => {
        it('Then git exits 128 with "fatal: failed to load bitmap indexes" — documenting why the row above exits 0 rather than non-zero', () => {
          // Arrange
          const sut = tryRunGitWithExit;

          // Act
          const result = sut(['-C', f6.dir, 'rev-list', '--test-bitmap', 'HEAD']);

          // Assert
          expect(result.exitCode).toBe(128);
          expect(result.stderr).toContain('fatal: failed to load bitmap indexes');
        });
      });

      describe("When git pack-objects --revs runs against packObjects({ wants: ['HEAD'] }) at its default (bitmap) tier", () => {
        it("Then both write the WALK's object set (120), read back from the .idx, never compared on packId", async () => {
          // Arrange
          const gitPackDir = path.join(f6.dir, 'scratch-git-pack-objects');
          await mkdir(gitPackDir, { recursive: true });
          const sut = packObjects;

          // Act
          const gitPackSha = runGit(
            ['-C', f6.dir, 'pack-objects', '--revs', path.join(gitPackDir, 'out')],
            { input: 'HEAD\n', env: runGitEnv() },
          ).trim();
          const gitIds = await idxObjectIds(path.join(gitPackDir, `out-${gitPackSha}.idx`));
          const tsgitOut = await sut(trackedNodeContext(f6.dir), {
            wants: ['HEAD'],
            outputDirectory: path.join(f6.dir, 'scratch-tsgit-pack-objects'),
          });
          const tsgitIds = await idxObjectIds(
            path.join(f6.dir, 'scratch-tsgit-pack-objects', `pack-${tsgitOut.packId}.idx`),
          );

          // Assert
          expect(gitIds.size).toBe(120);
          expect(tsgitOut.objectCount).toBe(120);
          expect(tsgitIds.size).toBe(120);
          expect([...tsgitIds].sort()).toEqual([...gitIds].sort());
        });
      });

      describe('When the fallback count above is checked against an INDEPENDENT plain walk over the same fixture', () => {
        it('Then the fallback answer equals the walk exactly (120 = 120) — correct, not truncated', async () => {
          // Arrange
          const sut = revList;

          // Act
          const bitmapTier = await sut(trackedNodeContext(f6.dir), {
            wants: ['HEAD'],
            objects: true,
            useBitmapIndex: true,
          });
          const walkTier = await sut(trackedNodeContext(f6.dir), {
            wants: ['HEAD'],
            objects: true,
          });

          // Assert
          expect(bitmapTier.count).toBe(120);
          expect(walkTier.count).toBe(120);
          assertSameSet(tsgitObjectSet(bitmapTier).ids, tsgitObjectSet(walkTier).ids);
        });
      });
    },
  );

  // ---------------------------------------------------------------------
  // Degradation — every restamped STRUCTURAL corruption declines the WHOLE
  // artefact, silently, on both tools; the flag word cleared of full-DAG is
  // the one row where tsgit answers where git aborts. Fresh BASE bitmap
  // fixture (12 objects) per row — this matrix corrupts the SAME artefact
  // repeatedly and must never reuse a fixture another row already broke.
  // ---------------------------------------------------------------------

  describe('Given a fresh BASE bitmap fixture (12 objects) per row, When its .bitmap is structurally corrupted and RESTAMPED', () => {
    const STRUCTURAL_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (bytes: Buffer) => Buffer;
    }> = [
      {
        label: 'magic flipped',
        mutate: (bytes) => {
          bytes[3] = (bytes[3] ?? 0) ^ 0xff;
          return bytes;
        },
      },
      {
        label: 'version unsupported',
        mutate: (bytes) => {
          bytes.writeUInt16BE(2, 4);
          return bytes;
        },
      },
      {
        label: 'entry count inflated past the file',
        mutate: (bytes) => {
          bytes.writeUInt32BE(999_999, 8);
          return bytes;
        },
      },
      {
        label: 'truncated (kept above one digest length)',
        mutate: (bytes) => bytes.subarray(0, Math.floor(bytes.length / 2)),
      },
      {
        label: 'first stream declares an oversized word count',
        mutate: (bytes) => {
          bytes.writeUInt32BE(0xffffff, 12 + 20 + 4);
          return bytes;
        },
      },
    ];

    describe.each(STRUCTURAL_ROWS)('And the corruption is: $label', ({ mutate }) => {
      it('Then both tools decline the WHOLE artefact and fall back to the walk (12 = 12), and tsgit warns exactly once', async () => {
        // Arrange
        const base = await buildBitmapFixture(await newRoot('degrade-structural'), 'repo');
        const packDir = path.join(base.dir, '.git', 'objects', 'pack');
        const bitmapName = (await readdir(packDir)).find((name) => name.endsWith('.bitmap'));
        if (bitmapName === undefined) throw new Error('expected a .bitmap file in BASE pack dir');
        const bitmapPath = path.join(packDir, bitmapName);
        mutateOrThrow(bitmapPath, mutate);
        mutateOrThrow(bitmapPath, restampBitmap);
        const gitResult = tryRunGitWithExit([
          '-C',
          base.dir,
          'rev-list',
          '--use-bitmap-index',
          '--objects',
          'HEAD',
        ]);
        const warnCalls: unknown[][] = [];
        const sut = revList;

        // Act
        const result = await sut(
          trackedNodeContextWithWarnSpy(base.dir, (...args) => warnCalls.push(args)),
          { wants: ['HEAD'], objects: true, useBitmapIndex: true },
        );

        // Assert — git degrades silently (exit 0) to its own walk.
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout.split('\n').filter(Boolean)).toHaveLength(12);
        // Assert — tsgit degrades the same way, warning once.
        expect(result.count).toBe(12);
        expect(warnCalls).toHaveLength(1);
      });
    });

    it('Then clearing the FLAG WORD of full-DAG instead makes git ABORT on load while tsgit still answers correctly (12) — the detector this suite depends on for the F3 artefact-preference rows', async () => {
      // Arrange
      const base = await buildBitmapFixture(await newRoot('degrade-full-dag'), 'repo');
      const packDir = path.join(base.dir, '.git', 'objects', 'pack');
      const bitmapName = (await readdir(packDir)).find((name) => name.endsWith('.bitmap'));
      if (bitmapName === undefined) throw new Error('expected a .bitmap file in BASE pack dir');
      const bitmapPath = path.join(packDir, bitmapName);
      mutateOrThrow(bitmapPath, clearFullDagFlagAndRestamp);
      const sut = revList;

      // Act
      const gitAborted = gitAborts(base.dir, 'rev-list', '--use-bitmap-index', '--objects', 'HEAD');
      const result = await sut(trackedNodeContext(base.dir), {
        wants: ['HEAD'],
        objects: true,
        useBitmapIndex: true,
      });

      // Assert
      expect(gitAborted).toBe(true);
      expect(result.count).toBe(12);
    });
  });
});
