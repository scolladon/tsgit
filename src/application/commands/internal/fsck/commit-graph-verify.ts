/**
 * git's fsck runs `git commit-graph verify --object-dir <dir>` for every
 * object source while `core.commitGraph` is on, and sets bit 16 when any of
 * them reports. This pass is that verify over each source's single-file graph.
 */
import {
  type CommitData,
  type CommitGraphLayer,
  commitDataAt,
  parseCommitGraphLayer,
} from '../../../../domain/commit/commit-graph.js';
import { commitGraphLoadFailure } from '../../../../domain/commit/commit-graph-load.js';
import {
  type CommitGraphVerdict,
  graphOidAt,
  graphParentPositions,
  verifyGraphStructure,
} from '../../../../domain/commit/commit-graph-verify.js';
import { TsgitError } from '../../../../domain/error.js';
import { errorDataCode } from '../../../../domain/error-data-code.js';
import { bytesEqual } from '../../../../domain/objects/encoding.js';
import type { Commit, ObjectId } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import {
  commitGraphEnabled,
  isGraphDecodeFailure,
} from '../../../primitives/internal/read-commit-graph.js';
import { getObjectStore, type ObjectSource } from '../../../primitives/object-store.js';
import { commitGraphChainPathIn, commitGraphPathIn } from '../../../primitives/path-layout.js';
import { readObject } from '../../../primitives/read-object.js';
import { EXIT_COMMIT_GRAPH } from './exit-codes.js';
import { attributeTo } from './source-attribution.js';
import type { FsckFinding } from './types.js';

const GENERATION_NUMBER_V1_MAX = 0x3fffffff;

interface PassResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitBit: number;
}

export async function runCommitGraphVerifyPass(ctx: Context): Promise<PassResult> {
  if (!(await commitGraphEnabled(ctx))) return { findings: [], exitBit: 0 };
  const store = await getObjectStore(ctx);
  const findings: FsckFinding[] = [];
  for (const source of store.sources) {
    const { artefact, verdicts } = await verifySource(ctx, source);
    const attribution = attributeTo(store, source);
    for (const verdict of verdicts) {
      findings.push({ type: 'commit-graph-invalid', artefact, ...attribution, ...verdict });
    }
  }
  return { findings, exitBit: findings.length > 0 ? EXIT_COMMIT_GRAPH : 0 };
}

async function readGraphBytes(source: ObjectSource): Promise<Uint8Array | undefined> {
  try {
    return await source.fs.read(commitGraphPathIn(source.objectsDir));
  } catch (error) {
    if (errorDataCode(error) === 'FILE_NOT_FOUND') return undefined;
    throw error;
  }
}

/** git's loader refusal first; tsgit's own decode refusal only past every check git makes. */
function parseLayer(bytes: Uint8Array, hashLength: number): CommitGraphLayer | CommitGraphVerdict {
  const failure = commitGraphLoadFailure(bytes, hashLength);
  if (failure !== undefined) return { check: 'load-failure', failure };
  try {
    return parseCommitGraphLayer(bytes);
  } catch (error) {
    if (!isGraphDecodeFailure(error)) throw error;
    return {
      check: 'load-failure',
      failure: { kind: 'malformed', reason: (error as Error).message },
    };
  }
}

interface SourceReport {
  /** The file the verdicts are about: the single graph, or the chain when there is none. */
  readonly artefact: string;
  readonly verdicts: ReadonlyArray<CommitGraphVerdict>;
}

/** git's `graph_verify`: the single file when it opens, otherwise the chain. */
async function verifySource(ctx: Context, source: ObjectSource): Promise<SourceReport> {
  const bytes = await readGraphBytes(source);
  if (bytes === undefined) return chainReport(source);
  return {
    artefact: commitGraphPathIn(source.objectsDir),
    verdicts: await verifyGraph(ctx, bytes),
  };
}

/** An absent chain verifies nothing; one that will not open is where git's verify dies. */
async function chainReport(source: ObjectSource): Promise<SourceReport> {
  const artefact = commitGraphChainPathIn(source.objectsDir);
  const code = await chainOpenFailure(source, artefact);
  return { artefact, verdicts: code === undefined ? [] : [{ check: 'chain-unopenable', code }] };
}

async function chainOpenFailure(source: ObjectSource, path: string): Promise<string | undefined> {
  try {
    await source.fs.read(path);
    return undefined;
  } catch (error) {
    const code = errorDataCode(error);
    if (code === undefined) throw error;
    return code === 'FILE_NOT_FOUND' ? undefined : code;
  }
}

async function verifyGraph(
  ctx: Context,
  bytes: Uint8Array,
): Promise<ReadonlyArray<CommitGraphVerdict>> {
  const layer = parseLayer(bytes, ctx.hashConfig.digestLength);
  if ('check' in layer) return [layer];
  const checksum = await checksumVerdicts(ctx, bytes);
  const structure = verifyGraphStructure(layer, layer.commitCount);
  const early = [...checksum, ...structure.verdicts];
  if (structure.fatal || structure.verdicts.length > 0) return early;
  return [...early, ...(await verifyAgainstObjects(ctx, layer))];
}

async function checksumVerdicts(
  ctx: Context,
  bytes: Uint8Array,
): Promise<ReadonlyArray<CommitGraphVerdict>> {
  const trailerStart = bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  return bytesEqual(digest, bytes.subarray(trailerStart)) ? [] : [{ check: 'checksum' }];
}

interface OdbWalk {
  readonly layer: CommitGraphLayer;
  readonly corrected: boolean;
  readonly verdicts: CommitGraphVerdict[];
  seenZero: ObjectId | undefined;
  seenNonZero: ObjectId | undefined;
}

async function verifyAgainstObjects(
  ctx: Context,
  layer: CommitGraphLayer,
): Promise<ReadonlyArray<CommitGraphVerdict>> {
  const corrected = layer._generationDataRange !== undefined;
  const walk: OdbWalk = {
    layer,
    corrected,
    verdicts: [],
    seenZero: undefined,
    seenNonZero: undefined,
  };
  for (let position = 0; position < layer.commitCount; position += 1) {
    await verifyCommit(ctx, walk, position);
  }
  if (walk.seenZero !== undefined && walk.seenNonZero !== undefined) {
    walk.verdicts.push({
      check: 'mixed-generations',
      zero: walk.seenZero,
      nonZero: walk.seenNonZero,
    });
  }
  return walk.verdicts;
}

/** git's `repo_parse_commit_internal` on a fresh commit: any read refusal is a parse failure. */
async function readOdbCommit(ctx: Context, id: ObjectId): Promise<Commit | undefined> {
  try {
    const object = await readObject(ctx, id);
    return object.type === 'commit' ? object : undefined;
  } catch (error) {
    if (error instanceof TsgitError) return undefined;
    throw error;
  }
}

async function verifyCommit(ctx: Context, walk: OdbWalk, position: number): Promise<void> {
  const id = graphOidAt(walk.layer, position);
  const odb = await readOdbCommit(ctx, id);
  if (odb === undefined) {
    walk.verdicts.push({ check: 'odb-unparsable', id });
    return;
  }
  const data = commitDataAt(walk.layer, position, { correctedCommitDates: walk.corrected });
  if (data.rootTree !== odb.data.tree) {
    walk.verdicts.push({ check: 'root-tree', id, recorded: data.rootTree, actual: odb.data.tree });
  }
  const maxGeneration = compareParents(walk, position, id, odb.data.parents);
  checkGeneration(walk, id, data, maxGeneration, odb.data.committer.timestamp);
}

/** The parent walk; answers the highest generation among the graph parents it visited. */
function compareParents(
  walk: OdbWalk,
  position: number,
  id: ObjectId,
  odbParents: ReadonlyArray<ObjectId>,
): number {
  const graphParents = graphParentPositions(walk.layer, position, walk.corrected);
  let maxGeneration = 0;
  for (const [index, parentPosition] of graphParents.entries()) {
    const actual = odbParents[index];
    if (actual === undefined) {
      walk.verdicts.push({ check: 'parents-too-long', id });
      return maxGeneration;
    }
    const recorded = graphOidAt(walk.layer, parentPosition);
    if (recorded !== actual) walk.verdicts.push({ check: 'parent', id, recorded, actual });
    const options = { correctedCommitDates: walk.corrected };
    maxGeneration = Math.max(
      maxGeneration,
      commitDataAt(walk.layer, parentPosition, options).generation,
    );
  }
  if (odbParents.length > graphParents.length) {
    walk.verdicts.push({ check: 'parents-terminate-early', id });
  }
  return maxGeneration;
}

function checkGeneration(
  walk: OdbWalk,
  id: ObjectId,
  data: CommitData,
  maxGeneration: number,
  odbDate: number,
): void {
  if (data.generation === 0) walk.seenZero = id;
  else walk.seenNonZero = id;
  if (walk.seenZero !== undefined) return;
  const capped =
    !walk.corrected && maxGeneration === GENERATION_NUMBER_V1_MAX
      ? maxGeneration - 1
      : maxGeneration;
  if (data.generation < capped + 1) {
    walk.verdicts.push({
      check: 'generation',
      id,
      generation: data.generation,
      minimum: capped + 1,
    });
  }
  if (data.committerDate !== odbDate) {
    walk.verdicts.push({
      check: 'commit-date',
      id,
      recordedDate: data.committerDate,
      actualDate: odbDate,
    });
  }
}
