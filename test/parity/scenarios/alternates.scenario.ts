/**
 * Alternates — an object that lives only in a donor object directory is read
 * through `objects/info/alternates` on every adapter, and `objectSources()`
 * lists the donor as a non-local source. The memory-only variant lists an
 * alternate outside the adapter's root, which the memory adapter reports as
 * `unreachable` because it has no filesystem beyond its root.
 *
 * Surfaces closed:
 *   primitives: objectSources, readBlob
 */
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import { computeLooseObjectPath } from '../../../src/domain/storage/loose-path.ts';
import type { Repository } from '../../../src/repository.ts';
import { AUTHOR } from '../fixtures.ts';
import type { Scenario } from './types.ts';

interface AlternatesResult {
  readonly donorBlobText: string;
  readonly sourceLocality: ReadonlyArray<boolean>;
  readonly unusableReasons: ReadonlyArray<string>;
}

interface OutOfRootResult {
  readonly sourceLocality: ReadonlyArray<boolean>;
  readonly unusableReasons: ReadonlyArray<string>;
}

const DONOR_CONTENT = 'only in the donor\n';
const OUT_OF_ROOT_OBJECTS_DIR = '/elsewhere/objects';

const parityInputs = {
  files: [],
  author: AUTHOR,
  message: 'unused (no commit in this scenario)',
} as const;

const listAlternate = (repo: Repository, objectsDir: string): Promise<void> =>
  repo.ctx.fs.writeUtf8(`${repo.ctx.layout.gitDir}/objects/info/alternates`, `${objectsDir}\n`);

async function writeDonorLooseBlob(repo: Repository, donorObjectsDir: string): Promise<ObjectId> {
  const body = new TextEncoder().encode(DONOR_CONTENT);
  const framed = new Uint8Array([...new TextEncoder().encode(`blob ${body.length}\0`), ...body]);
  const id = await repo.primitives.hashBlob(body);
  const deflated = await repo.ctx.compressor.deflate(framed);
  await repo.ctx.fs.write(`${donorObjectsDir}/${computeLooseObjectPath(id)}`, deflated);
  return id;
}

const describeSources = async (
  repo: Repository,
): Promise<Pick<OutOfRootResult, 'sourceLocality' | 'unusableReasons'>> => {
  const view = await repo.primitives.objectSources();
  return {
    sourceLocality: view.sources.map((source) => source.local),
    unusableReasons: view.unusable.map((diagnostic) => diagnostic.reason),
  };
};

export const alternatesScenario: Scenario<AlternatesResult> = {
  name: 'alternates',
  // The alternate chain reads `core.ignorecase` through every config scope, and
  // the global scope asks Deno's node shim for `homedir()`, which the runtime
  // suite (no `--allow-sys`) denies. Node and memory parity prove the contract.
  unsupportedRuntimes: ['deno'],
  inputs: parityInputs,
  expected: {
    donorBlobText: DONOR_CONTENT,
    sourceLocality: [true, false],
    unusableReasons: [],
  },
  run: async (repo) => {
    await repo.init();
    const donorObjectsDir = `${repo.ctx.layout.workDir}/donor/objects`;
    const id = await writeDonorLooseBlob(repo, donorObjectsDir);
    await listAlternate(repo, donorObjectsDir);

    const blob = await repo.primitives.readBlob(id);

    return {
      donorBlobText: new TextDecoder().decode(blob.content),
      ...(await describeSources(repo)),
    };
  },
};

/** Memory adapter only: node reads an out-of-root alternate straight from disk. */
export const alternatesOutOfRootScenario: Scenario<OutOfRootResult> = {
  name: 'alternates-out-of-root',
  inputs: parityInputs,
  expected: {
    sourceLocality: [true],
    unusableReasons: ['unreachable'],
  },
  run: async (repo) => {
    await repo.init();
    await listAlternate(repo, OUT_OF_ROOT_OBJECTS_DIR);

    return describeSources(repo);
  },
};
