/**
 * Cross-tool interop — commit-graph files across alternate object stores. A
 * borrower is a real `git clone --shared` of a donor; each row plants a graph
 * (single file or split chain, possibly damaged) in the borrower and/or the
 * donor, deletes a covered commit object, and asks git whether
 * `rev-list --count HEAD` still succeeds — it does only when git served the
 * commit from a graph. tsgit's oracle is `commitHeader` of that commit: defined
 * exactly when git succeeded (a rev-list success alone proves nothing).
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         tsgit loads commit-graph files from every object source, in the order and with the fallbacks real git uses
 *   interopSurface: packfile
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeClosure } from '../../src/application/primitives/internal/closure-engine.js';
import { commitHeader } from '../../src/application/primitives/internal/read-commit-graph.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 120_000;
const ROW_TIMEOUT = 30_000;
const GIT_SUCCEEDED = 0;
const GIT_REFUSED = 128;
const COMMITS_IN_DONOR = 4;
const MISSING_LAYER_WARNING = 'unable to find all commit-graph files';
const TOO_SMALL_WARNING = 'commit-graph file is too small';
const ABSENT_LAYER_HASH = 'ab'.repeat(20);
const GARBAGE = Buffer.from([1, 2, 3]);
const SMASHED_HEADER = Buffer.from('XXXX');
const BITMAP_HEADER_ERROR = 'corrupted bitmap index file (wrong header)';
const MIDX_SIGNATURE_ERROR = 'multi-pack-index signature';

let root: string;
let rowCount = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-alt-graph-')));
}, SETUP_TIMEOUT);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Repo {
  readonly dir: string;
  readonly objects: string;
}

interface World {
  readonly donor: Repo;
  readonly borrower: Repo;
  /** Donor commits, oldest first. */
  readonly commits: ReadonlyArray<string>;
}

const configure = (dir: string): void => {
  for (const [key, value] of [
    ['user.name', 'Ada'],
    ['user.email', 'ada@example.com'],
    ['commit.gpgSign', 'false'],
  ] as const) {
    runGit(['-C', dir, 'config', key, value]);
  }
  disableAutoMaintenance(dir);
};

const repoAt = (dir: string): Repo => ({ dir, objects: path.join(dir, '.git', 'objects') });

const commitEmpty = (repo: Repo, message: string): void => {
  runGit(['-C', repo.dir, 'commit', '-q', '--allow-empty', '-m', message]);
};

const commitsOf = (repo: Repo): ReadonlyArray<string> =>
  runGit(['-C', repo.dir, 'rev-list', '--reverse', 'HEAD']).trim().split('\n');

/** A donor with four commits and a `--shared` borrower of it, both fresh for one row. */
const buildWorld = (): World => {
  rowCount += 1;
  const donorDir = path.join(root, `donor-${rowCount}`);
  runGit(['init', '-q', '-b', 'main', donorDir]);
  const donor = repoAt(donorDir);
  configure(donorDir);
  for (let n = 1; n <= COMMITS_IN_DONOR; n += 1) commitEmpty(donor, `c${n}`);
  const borrowerDir = path.join(root, `borrower-${rowCount}`);
  runGit(['clone', '-q', '--shared', donorDir, borrowerDir]);
  configure(borrowerDir);
  return { donor, borrower: repoAt(borrowerDir), commits: commitsOf(donor) };
};

const writeGraph = (repo: Repo, ...args: ReadonlyArray<string>): void => {
  runGit(['-C', repo.dir, 'commit-graph', 'write', ...args]);
};

const writeGraphCovering = (repo: Repo, oids: ReadonlyArray<string>): void => {
  runGit(['-C', repo.dir, 'commit-graph', 'write', '--stdin-commits'], {
    input: `${oids.join('\n')}\n`,
  });
};

const graphsDir = (repo: Repo): string => path.join(repo.objects, 'info', 'commit-graphs');

const layerFiles = (repo: Repo): ReadonlyArray<string> =>
  existsSync(graphsDir(repo))
    ? readdirSync(graphsDir(repo)).filter((name) => name.endsWith('.graph'))
    : [];

const nth = (world: World, index: number): string => {
  const oid = world.commits[index];
  if (oid === undefined) throw new Error(`fixture has no commit #${index}`);
  return oid;
};

const onlyLayer = (repo: Repo): string => {
  const [layer, ...rest] = layerFiles(repo);
  if (layer === undefined || rest.length > 0) throw new Error('expected exactly one layer file');
  return layer;
};

const deleteObject = (repo: Repo, oid: string): void => {
  rmSync(path.join(repo.objects, oid.slice(0, 2), oid.slice(2)));
};

const revListCount = (repo: Repo, ...config: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', repo.dir, ...config, 'rev-list', '--count', 'HEAD']);

const withoutGraph = (repo: Repo) => revListCount(repo, '-c', 'core.commitGraph=false');

const tsgitServesFromGraph = async (repo: Repo, oid: string): Promise<boolean> => {
  const opened = await openRepository({ cwd: repo.dir });
  try {
    return (await commitHeader(opened.ctx, oid as ObjectId)) !== undefined;
  } finally {
    await opened.dispose?.();
  }
};

const repackWithBitmap = (repo: Repo): void => {
  runGit(['-C', repo.dir, 'repack', '-a', '-d', '-q', '--write-bitmap-index']);
};

const onlyBitmap = (repo: Repo): string => {
  const packDir = path.join(repo.objects, 'pack');
  const [bitmap, ...rest] = readdirSync(packDir).filter((name) => name.endsWith('.bitmap'));
  if (bitmap === undefined || rest.length > 0) throw new Error('expected exactly one bitmap file');
  return path.join(packDir, bitmap);
};

const gitObjects = (repo: Repo) => {
  const result = tryRunGitWithExit([
    '-C',
    repo.dir,
    'rev-list',
    '--objects',
    '--use-bitmap-index',
    'HEAD',
  ]);
  const ids = result.stdout
    .split('\n')
    .map((line) => line.split(' ')[0] ?? '')
    .filter((id) => id !== '')
    .sort();
  return { ...result, ids };
};

const bitmapRequest = (oid: ObjectId) =>
  ({ tier: 'bitmap', wants: [oid], not: [], objects: true }) as const;

const bitmapClosure = async (repo: Repo) => {
  const opened = await openRepository({ cwd: repo.dir });
  try {
    const head = runGit(['-C', repo.dir, 'rev-parse', 'HEAD']).trim() as ObjectId;
    const result = await computeClosure(opened.ctx, bitmapRequest(head));
    return { tier: result.tier, ids: result.objects.map((object) => object.id).sort() };
  } finally {
    await opened.dispose?.();
  }
};

const bitmapClosureRefusal = async (repo: Repo): Promise<unknown> => {
  try {
    await bitmapClosure(repo);
  } catch (error) {
    return (error as { data: unknown }).data;
  }
  return undefined;
};

/** The borrower gains a fifth commit and a split chain layered on the donor's chain. */
const splitChainAcrossSources = (world: World): void => {
  writeGraph(world.donor, '--reachable', '--split');
  commitEmpty(world.borrower, 'c5');
  writeGraph(world.borrower, '--reachable', '--split=no-merge');
};

describe.skipIf(!GIT_AVAILABLE)('alternates commit-graph interop', () => {
  describe('Given a graph only in the donor', () => {
    describe('When a covered commit object is deleted from the donor', () => {
      it(
        'Then git and tsgit both serve it from the donor graph',
        async () => {
          // Arrange
          const world = buildWorld();
          writeGraph(world.donor, '--reachable');
          const covered = nth(world, 1);
          deleteObject(world.donor, covered);

          // Act
          const git = revListCount(world.borrower);
          const control = withoutGraph(world.borrower);
          const served = await tsgitServesFromGraph(world.borrower, covered);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.stdout.trim()).toBe(String(COMMITS_IN_DONOR));
          expect(control.exitCode).toBe(GIT_REFUSED);
          expect(served).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower graph covering c1..c2 and a donor graph covering every commit', () => {
    describe('When c3, which only the donor graph covers, is deleted from the donor', () => {
      it(
        'Then the primary graph wins in git and in tsgit',
        async () => {
          // Arrange
          const world = buildWorld();
          writeGraph(world.donor, '--reachable');
          writeGraphCovering(world.borrower, [nth(world, 1)]);
          const uncovered = nth(world, 2);
          deleteObject(world.donor, uncovered);

          // Act
          const git = revListCount(world.borrower);
          const donorAlone = revListCount(world.donor);
          const served = await tsgitServesFromGraph(world.borrower, uncovered);

          // Assert
          expect(git.exitCode).toBe(GIT_REFUSED);
          expect(donorAlone.exitCode).toBe(GIT_SUCCEEDED);
          expect(served).toBe(false);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower split chain whose base layer exists only in the donor', () => {
    describe('When a commit of the base layer is deleted from the donor', () => {
      it(
        'Then git and tsgit both find the layer in the donor',
        async () => {
          // Arrange
          const world = buildWorld();
          splitChainAcrossSources(world);
          const covered = nth(world, 0);
          deleteObject(world.donor, covered);

          // Act
          const git = revListCount(world.borrower);
          const control = withoutGraph(world.borrower);
          const served = await tsgitServesFromGraph(world.borrower, covered);

          // Assert
          expect(layerFiles(world.borrower)).toHaveLength(1);
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(control.exitCode).toBe(GIT_REFUSED);
          expect(served).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given the same chain with the borrower tip layer file removed', () => {
    describe('When a commit of the base layer is deleted from the donor', () => {
      it(
        'Then both serve the loaded prefix and git warns',
        async () => {
          // Arrange
          const world = buildWorld();
          splitChainAcrossSources(world);
          const tipLayer = onlyLayer(world.borrower);
          rmSync(path.join(graphsDir(world.borrower), tipLayer));
          const covered = nth(world, 0);
          deleteObject(world.donor, covered);

          // Act
          const git = revListCount(world.borrower);
          const served = await tsgitServesFromGraph(world.borrower, covered);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.stderr).toContain(MISSING_LAYER_WARNING);
          expect(served).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given the same chain with the donor base layer file removed', () => {
    describe('When a commit of the base layer is deleted from the donor', () => {
      it(
        'Then neither serves a graph',
        async () => {
          // Arrange
          const world = buildWorld();
          splitChainAcrossSources(world);
          const baseLayer = onlyLayer(world.donor);
          rmSync(path.join(graphsDir(world.donor), baseLayer));
          const covered = nth(world, 0);
          deleteObject(world.donor, covered);

          // Act
          const git = revListCount(world.borrower);
          const served = await tsgitServesFromGraph(world.borrower, covered);

          // Assert
          expect(git.exitCode).toBe(GIT_REFUSED);
          expect(git.stderr).toContain(MISSING_LAYER_WARNING);
          expect(served).toBe(false);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower chain naming a layer that exists nowhere and a donor single graph', () => {
    describe('When a covered commit is deleted from the donor', () => {
      it(
        'Then the empty prefix moves on to the donor graph in both',
        async () => {
          // Arrange
          const world = buildWorld();
          writeGraph(world.donor, '--reachable');
          mkdirSync(graphsDir(world.borrower), { recursive: true });
          writeFileSync(
            path.join(graphsDir(world.borrower), 'commit-graph-chain'),
            `${ABSENT_LAYER_HASH}\n`,
          );
          const covered = nth(world, 0);
          deleteObject(world.donor, covered);

          // Act
          const git = revListCount(world.borrower);
          const served = await tsgitServesFromGraph(world.borrower, covered);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.stderr).toContain(MISSING_LAYER_WARNING);
          expect(served).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a corrupt borrower single graph and a donor single graph', () => {
    describe('When a covered commit is deleted from the donor', () => {
      it(
        'Then the corrupt file is skipped and the donor graph serves in both',
        async () => {
          // Arrange
          const world = buildWorld();
          writeGraph(world.donor, '--reachable');
          mkdirSync(path.join(world.borrower.objects, 'info'), { recursive: true });
          writeFileSync(path.join(world.borrower.objects, 'info', 'commit-graph'), GARBAGE);
          const covered = nth(world, 0);
          deleteObject(world.donor, covered);

          // Act
          const git = revListCount(world.borrower);
          const served = await tsgitServesFromGraph(world.borrower, covered);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.stderr).toContain(TOO_SMALL_WARNING);
          expect(served).toBe(true);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor pack bitmap and a bitmap-less borrower', () => {
    describe('When a bitmap-tier closure is computed over HEAD', () => {
      it(
        'Then the donor bitmap answers with the object set git lists',
        async () => {
          // Arrange
          const world = buildWorld();
          repackWithBitmap(world.donor);

          // Act
          const git = gitObjects(world.borrower);
          const closure = await bitmapClosure(world.borrower);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(closure.tier).toBe('bitmap');
          expect(closure.ids).toEqual(git.ids);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a donor pack bitmap with a smashed header, the only bitmap', () => {
    describe('When a bitmap-tier closure is computed over HEAD', () => {
      it(
        'Then both fall back to the walk and list the same objects',
        async () => {
          // Arrange
          const world = buildWorld();
          repackWithBitmap(world.donor);
          const bitmap = onlyBitmap(world.donor);
          const original = readFileSync(bitmap);
          rmSync(bitmap);
          writeFileSync(bitmap, Buffer.concat([SMASHED_HEADER, original.subarray(4)]));

          // Act
          const git = gitObjects(world.borrower);
          const closure = await bitmapClosure(world.borrower);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.stderr).toContain(BITMAP_HEADER_ERROR);
          expect(closure.tier).toBe('walk');
          expect(closure.ids).toEqual(git.ids);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower pack bitmap and a donor multi-pack-index with a smashed signature', () => {
    describe('When a bitmap-tier closure is computed over HEAD', () => {
      it(
        'Then git refuses and tsgit refuses with the signature check',
        async () => {
          // Arrange
          const world = buildWorld();
          runGit(['-C', world.donor.dir, 'repack', '-a', '-d', '-q']);
          runGit(['-C', world.donor.dir, 'multi-pack-index', 'write']);
          commitEmpty(world.borrower, 'c5');
          runGit([
            '-C',
            world.borrower.dir,
            'repack',
            '-a',
            '-d',
            '-l',
            '-q',
            '--write-bitmap-index',
          ]);
          const midx = path.join(world.donor.objects, 'pack', 'multi-pack-index');
          writeFileSync(midx, Buffer.concat([SMASHED_HEADER, readFileSync(midx).subarray(4)]));

          // Act
          const git = gitObjects(world.borrower);
          const refusal = await bitmapClosureRefusal(world.borrower);

          // Assert
          expect(git.exitCode).toBe(GIT_REFUSED);
          expect(git.stderr).toContain(MIDX_SIGNATURE_ERROR);
          expect(refusal).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a borrower multi-pack-index bitmap and a donor multi-pack-index with a smashed signature', () => {
    describe('When a bitmap-tier closure is computed over HEAD', () => {
      it(
        'Then git refuses and tsgit refuses with the signature check, though the borrower bitmap answers alone',
        async () => {
          // Arrange
          const world = buildWorld();
          runGit(['-C', world.donor.dir, 'repack', '-a', '-d', '-q']);
          runGit(['-C', world.donor.dir, 'multi-pack-index', 'write']);
          commitEmpty(world.borrower, 'c5');
          runGit([
            '-C',
            world.borrower.dir,
            'repack',
            '-a',
            '-d',
            '-q',
            '--write-midx',
            '--write-bitmap-index',
          ]);
          const midx = path.join(world.donor.objects, 'pack', 'multi-pack-index');
          writeFileSync(midx, Buffer.concat([SMASHED_HEADER, readFileSync(midx).subarray(4)]));

          // Act
          const git = gitObjects(world.borrower);
          const refusal = await bitmapClosureRefusal(world.borrower);

          // Assert
          expect(git.exitCode).toBe(GIT_REFUSED);
          expect(git.stderr).toContain(MIDX_SIGNATURE_ERROR);
          expect(refusal).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' });
        },
        ROW_TIMEOUT,
      );
    });
  });
});
