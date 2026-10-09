/**
 * git's fsck runs `git commit-graph verify --object-dir <dir>` for every
 * object source while `core.commitGraph` is on, and sets bit 16 when any of
 * them reports. This pass is that verify over each source's single file,
 * or its chain when there is none.
 */
import {
  type CommitData,
  type CommitGraphLayer,
  commitDataAt,
} from '../../../../domain/commit/commit-graph.js';
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
  type ChainLayer,
  loadChain,
  parseLayer,
} from '../../../primitives/internal/commit-graph-chain.js';
import { commitGraphEnabled } from '../../../primitives/internal/read-commit-graph.js';
import {
  getObjectStore,
  type ObjectSource,
  type ObjectStore,
} from '../../../primitives/object-store.js';
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
    const { artefact, verdicts } = await verifySource(ctx, store, source);
    const attribution = attributeTo(store, source);
    for (const verdict of verdicts) {
      findings.push({ type: 'commit-graph-invalid', artefact, ...attribution, ...verdict });
    }
  }
  return { findings, exitBit: findings.length > 0 ? EXIT_COMMIT_GRAPH : 0 };
}

/** An absent or empty chain is no chain; any other refusal names its error code. */
async function readGraphFile(source: ObjectSource, path: string): Promise<GraphFile> {
  try {
    const bytes = await source.fs.read(path);
    return bytes.length === 0 ? { absent: true } : { absent: false, bytes };
  } catch (error) {
    const code = errorDataCode(error);
    if (code === undefined) throw error;
    return code === 'FILE_NOT_FOUND' ? { absent: true } : { absent: false, code };
  }
}

type GraphFile =
  | { readonly absent: true }
  | { readonly absent: false; readonly bytes: Uint8Array }
  | { readonly absent: false; readonly code: string };

interface SourceReport {
  /** The file the verdicts are about: the single graph, or the chain when there is none. */
  readonly artefact: string;
  readonly verdicts: ReadonlyArray<CommitGraphVerdict>;
}

/** git's `graph_verify`: the single file when it opens, otherwise the chain. */
async function verifySource(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
): Promise<SourceReport> {
  const artefact = commitGraphPathIn(source.objectsDir);
  const single = await source.fs.read(artefact).catch(absentAsUndefined);
  if (single === undefined) return chainReport(ctx, store, source);
  const parsed = parseLayer(single, ctx.hashConfig.digestLength);
  if ('check' in parsed) return { artefact, verdicts: [parsed] };
  const run = await verifyChain(ctx, [{ layer: parsed, baseCount: 0 }]);
  return { artefact, verdicts: run.verdicts };
}

const absentAsUndefined = (error: unknown): undefined => {
  if (errorDataCode(error) === 'FILE_NOT_FOUND') return undefined;
  throw error;
};

async function chainReport(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
): Promise<SourceReport> {
  const artefact = commitGraphChainPathIn(source.objectsDir);
  const file = await readGraphFile(source, artefact);
  return { artefact, verdicts: await chainVerdicts(ctx, store, file) };
}

async function chainVerdicts(
  ctx: Context,
  store: ObjectStore,
  file: GraphFile,
): Promise<ReadonlyArray<CommitGraphVerdict>> {
  if (file.absent) return [];
  if ('code' in file) return [{ check: 'chain-unopenable', code: file.code }];
  if (file.bytes.length < ctx.hashConfig.digestLength * 2) return [{ check: 'chain-too-small' }];
  const chain = await loadChain(ctx, store.sources, file.bytes);
  if (chain.layers.length === 0) return [...chain.verdicts, { check: 'chain-unloaded' }];
  const run = await verifyChain(ctx, chain.layers);
  const incomplete: CommitGraphVerdict[] =
    chain.incomplete && !run.died ? [{ check: 'chain-incomplete' }] : [];
  return [...chain.verdicts, ...run.verdicts, ...incomplete];
}

/** git's `verify_commit_graph_error`: one state across every layer of the verify. */
interface VerifyRun {
  readonly verdicts: CommitGraphVerdict[];
  state: 'clean' | 'checksum' | 'reported';
  died: boolean;
}

const report = (run: VerifyRun, verdict: CommitGraphVerdict): void => {
  run.verdicts.push(verdict);
  run.state = 'reported';
};

/** git's `verify_commit_graph`: tip to base, a die ending the whole verify. */
async function verifyChain(ctx: Context, layers: ReadonlyArray<ChainLayer>): Promise<VerifyRun> {
  const run: VerifyRun = { verdicts: [], state: 'clean', died: false };
  const graph: ChainGraph = {
    layers,
    corrected: layers.every(({ layer }) => layer._generationDataRange !== undefined),
  };
  for (const entry of [...layers].reverse()) {
    await verifyLayer(ctx, graph, entry, run);
    if (run.died) break;
  }
  return run;
}

async function verifyLayer(
  ctx: Context,
  graph: ChainGraph,
  entry: ChainLayer,
  run: VerifyRun,
): Promise<void> {
  if (!(await checksumValid(ctx, entry.layer._bytes))) {
    report(run, { check: 'checksum' });
    run.state = 'checksum';
  }
  const structure = verifyGraphStructure(entry.layer, entry.baseCount + entry.layer.commitCount);
  for (const verdict of structure.verdicts) report(run, verdict);
  run.died = structure.fatal;
  if (run.died || run.state === 'reported') return;
  await verifyAgainstObjects(ctx, graph, entry, run);
}

async function checksumValid(ctx: Context, bytes: Uint8Array): Promise<boolean> {
  const trailerStart = bytes.length - ctx.hashConfig.digestLength;
  const digest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
  return bytesEqual(digest, bytes.subarray(trailerStart));
}

interface ChainGraph {
  readonly layers: ReadonlyArray<ChainLayer>;
  readonly corrected: boolean;
}

/** The layer and layer-local position holding chain-global `position`; layers sit base first. */
function slotOf(graph: ChainGraph, position: number): { layer: CommitGraphLayer; local: number } {
  let owner = graph.layers[0] as ChainLayer;
  for (const entry of graph.layers) {
    if (entry.baseCount <= position) owner = entry;
  }
  return { layer: owner.layer, local: position - owner.baseCount };
}

const oidAt = (graph: ChainGraph, position: number): ObjectId => {
  const { layer, local } = slotOf(graph, position);
  return graphOidAt(layer, local);
};

const generationAt = (graph: ChainGraph, position: number): number => {
  const { layer, local } = slotOf(graph, position);
  return commitDataAt(layer, local, { correctedCommitDates: graph.corrected }).generation;
};

interface OdbWalk {
  readonly graph: ChainGraph;
  readonly layer: CommitGraphLayer;
  readonly run: VerifyRun;
  seenZero: ObjectId | undefined;
  seenNonZero: ObjectId | undefined;
}

async function verifyAgainstObjects(
  ctx: Context,
  graph: ChainGraph,
  entry: ChainLayer,
  run: VerifyRun,
): Promise<void> {
  const walk: OdbWalk = {
    graph,
    layer: entry.layer,
    run,
    seenZero: undefined,
    seenNonZero: undefined,
  };
  for (let position = 0; position < entry.layer.commitCount; position += 1) {
    await verifyCommit(ctx, walk, position);
  }
  if (walk.seenZero !== undefined && walk.seenNonZero !== undefined) {
    report(run, { check: 'mixed-generations', zero: walk.seenZero, nonZero: walk.seenNonZero });
  }
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
    report(walk.run, { check: 'odb-unparsable', id });
    return;
  }
  const data = commitDataAt(walk.layer, position, { correctedCommitDates: walk.graph.corrected });
  if (data.rootTree !== odb.data.tree) {
    report(walk.run, { check: 'root-tree', id, recorded: data.rootTree, actual: odb.data.tree });
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
  const graphParents = graphParentPositions(walk.layer, position);
  let maxGeneration = 0;
  for (const [index, parentPosition] of graphParents.entries()) {
    const actual = odbParents[index];
    if (actual === undefined) {
      report(walk.run, { check: 'parents-too-long', id });
      return maxGeneration;
    }
    const recorded = oidAt(walk.graph, parentPosition);
    if (recorded !== actual) report(walk.run, { check: 'parent', id, recorded, actual });
    maxGeneration = Math.max(maxGeneration, generationAt(walk.graph, parentPosition));
  }
  if (odbParents.length > graphParents.length) {
    report(walk.run, { check: 'parents-terminate-early', id });
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
    !walk.graph.corrected && maxGeneration === GENERATION_NUMBER_V1_MAX
      ? maxGeneration - 1
      : maxGeneration;
  if (data.generation < capped + 1) {
    report(walk.run, { check: 'generation', id, generation: data.generation, minimum: capped + 1 });
  }
  if (data.committerDate !== odbDate) {
    report(walk.run, {
      check: 'commit-date',
      id,
      recordedDate: data.committerDate,
      actualDate: odbDate,
    });
  }
}
