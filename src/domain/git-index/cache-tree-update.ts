import { compareBytes, encode } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import { parseCarriedCacheTree } from './cache-tree.js';
import type { CacheTreeEntry, IndexEntry, IndexExtension } from './index-entry.js';
import { indexPathOfBytes, pathBytesOf } from './index-path-key.js';
import { compareEntryPath, pathComparatorFor } from './index-writer.js';

const SLASH = 0x2f;
const TREE_SIGNATURE = 'TREE';
const ROOT = 0;
const NO_CARRIED: ReadonlyArray<CacheTreeEntry> = [];

export interface PlannedNode {
  readonly nameBytes: Uint8Array;
  readonly entryCount: number;
  readonly reused?: ObjectId;
  /** The oid the carried node held before it was invalidated or outgrown. */
  readonly previousId?: ObjectId;
  readonly invalid: boolean;
  readonly children: ReadonlyArray<number>;
}

export interface TreeBuild {
  readonly node: number;
  readonly files: ReadonlyArray<IndexEntry>;
  readonly subtrees: ReadonlyArray<number>;
}

export interface CacheTreePlan {
  readonly nodes: ReadonlyArray<PlannedNode>;
  readonly builds: ReadonlyArray<TreeBuild>;
}

/** git's subtree_name_cmp: shorter name first, then bytes. */
export const compareSubtreeNames = (a: Uint8Array, b: Uint8Array): number =>
  a.length - b.length || compareBytes(a, b);

export const isIndexOrdered = (entries: ReadonlyArray<IndexEntry>): boolean => {
  for (let i = 1; i < entries.length; i++) {
    // Stryker disable next-line EqualityOperator: equivalent — equal paths only make the check fall to a stable sort that returns the same order
    if (compareEntryPath(entries[i - 1] as IndexEntry, entries[i] as IndexEntry) > 0) return false;
  }
  return true;
};

/** The TREE a previous index carries, or undefined when absent, unparseable or naming a subtree twice. */
export const carriedCacheTreeOf = (
  extensions: ReadonlyArray<IndexExtension>,
  digestLength: 20 | 32,
): CacheTreeEntry | undefined => {
  const tree = extensions.find((extension) => extension.signature === TREE_SIGNATURE);
  return tree === undefined ? undefined : parseCarriedCacheTree(tree.data, digestLength);
};

const nameOfCarried = (entry: CacheTreeEntry): Uint8Array => entry.nameBytes ?? encode(entry.path);

const isUsable = (entry: CacheTreeEntry): boolean => entry.entryCount >= 0;

interface Drafts {
  readonly names: Uint8Array[];
  readonly counts: number[];
  readonly reused: (ObjectId | undefined)[];
  readonly previous: (ObjectId | undefined)[];
  readonly invalid: boolean[];
  readonly children: number[][];
}

const addNode = (
  drafts: Drafts,
  name: Uint8Array,
  count: number,
  invalid: boolean,
  previous?: ObjectId,
): number => {
  drafts.names.push(name);
  drafts.counts.push(count);
  // Stryker disable next-line CallExpression: equivalent — reused is only read by index and set by index, a hole reads as undefined
  drafts.reused.push(undefined);
  drafts.previous.push(previous);
  drafts.invalid.push(invalid);
  drafts.children.push([]);
  return drafts.names.length - 1;
};

interface Run {
  readonly name: Uint8Array;
  readonly start: number;
  readonly end: number;
}

interface Region {
  readonly node: number;
  readonly start: number;
  readonly end: number;
  readonly prefixLength: number;
  readonly carried: ReadonlyArray<CacheTreeEntry>;
}

interface Scan {
  readonly files: IndexEntry[];
  readonly runs: Run[];
}

const slashAt = (bytes: Uint8Array, from: number): number => bytes.indexOf(SLASH, from);

const sharesDirectory = (
  candidate: Uint8Array,
  bytes: Uint8Array,
  from: number,
  until: number,
): boolean => {
  for (let k = from; k < until; k++) if (candidate[k] !== bytes[k]) return false;
  return true;
};

const isCommittable = (entry: IndexEntry): boolean =>
  entry.flags.stage === 0 && !entry.flags.intentToAdd;

const scanRegion = (
  entries: ReadonlyArray<IndexEntry>,
  paths: ReadonlyArray<Uint8Array>,
  region: Region,
): Scan => {
  const scan: Scan = { files: [], runs: [] };
  let i = region.start;
  while (i < region.end) {
    const bytes = paths[i] as Uint8Array;
    const slash = slashAt(bytes, region.prefixLength);
    if (slash === -1) {
      const entry = entries[i] as IndexEntry;
      if (isCommittable(entry)) scan.files.push(entry);
      i++;
      continue;
    }
    let end = i + 1;
    while (
      end < region.end &&
      sharesDirectory(paths[end] as Uint8Array, bytes, region.prefixLength, slash + 1)
    ) {
      end++;
    }
    scan.runs.push({ name: bytes.subarray(region.prefixLength, slash), start: i, end });
    i = end;
  }
  return scan;
};

const inSubtreeOrder = <T>(items: ReadonlyArray<T>, nameOf: (item: T) => Uint8Array): T[] => {
  const sorted = [...items];
  return sorted.sort((a, b) => compareSubtreeNames(nameOf(a), nameOf(b)));
};

/** Carried children are matched in one forward pass; an unordered carried list only costs reuse. */
const carriedMatches = (
  runs: ReadonlyArray<Run>,
  carried: ReadonlyArray<CacheTreeEntry>,
): (CacheTreeEntry | undefined)[] => {
  let cursor = 0;
  return runs.map((run) => {
    while (cursor < carried.length) {
      const order = compareSubtreeNames(nameOfCarried(carried[cursor] as CacheTreeEntry), run.name);
      if (order >= 0) return order === 0 ? (carried[cursor] as CacheTreeEntry) : undefined;
      cursor++;
    }
    return undefined;
  });
};

/** A reused subtree keeps its carried shape without being scanned. */
const mirrorCarried = (drafts: Drafts, root: number, carried: CacheTreeEntry): void => {
  const pending: { node: number; entry: CacheTreeEntry }[] = [{ node: root, entry: carried }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of orderedCarried(next.entry.children)) {
      const node = addNode(drafts, nameOfCarried(child), child.entryCount, false);
      drafts.reused[node] = isUsable(child) ? child.id : undefined;
      (drafts.children[next.node] as number[]).push(node);
      pending.push({ node, entry: child });
    }
  }
};

const orderedCarried = (children: ReadonlyArray<CacheTreeEntry>): ReadonlyArray<CacheTreeEntry> => {
  for (let i = 1; i < children.length; i++) {
    const before = nameOfCarried(children[i - 1] as CacheTreeEntry);
    if (compareSubtreeNames(before, nameOfCarried(children[i] as CacheTreeEntry)) > 0) {
      return inSubtreeOrder(children, nameOfCarried);
    }
  }
  return children;
};

const reusableId = (
  carried: CacheTreeEntry | undefined,
  count: number,
  invalid: boolean,
): ObjectId | undefined =>
  carried !== undefined && !invalid && carried.entryCount === count && isUsable(carried)
    ? carried.id
    : undefined;

interface Planning {
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly paths: ReadonlyArray<Uint8Array>;
  readonly badBefore: Uint32Array;
  readonly drafts: Drafts;
  readonly regions: Region[];
}

const badEntriesBefore = (entries: ReadonlyArray<IndexEntry>): Uint32Array => {
  const before = new Uint32Array(entries.length + 1);
  entries.forEach((entry, i) => {
    // Stryker disable next-line ArithmeticOperator: equivalent — the running total is negated modulo 2^32, so a range difference is zero exactly when it was
    before[i + 1] = (before[i] as number) + (isCommittable(entry) ? 0 : 1);
  });
  return before;
};

const planChild = (
  planning: Planning,
  parent: Region,
  run: Run,
  carried: CacheTreeEntry | undefined,
): number => {
  const { drafts, badBefore } = planning;
  const count = run.end - run.start;
  const invalid = (badBefore[run.end] as number) - (badBefore[run.start] as number) > 0;
  const node = addNode(drafts, run.name, count, invalid, carried?.id);
  (drafts.children[parent.node] as number[]).push(node);
  const reused = reusableId(carried, count, invalid);
  if (carried !== undefined && reused !== undefined) {
    drafts.reused[node] = reused;
    mirrorCarried(drafts, node, carried);
    return node;
  }
  planning.regions.push({
    node,
    start: run.start,
    end: run.end,
    prefixLength: parent.prefixLength + run.name.length + 1,
    carried: carried?.children ?? NO_CARRIED,
  });
  return node;
};

const expand = (planning: Planning, region: Region): TreeBuild => {
  const { files, runs } = scanRegion(planning.entries, planning.paths, region);
  const ordered = inSubtreeOrder(runs, (run) => run.name);
  const matches = carriedMatches(ordered, orderedCarried(region.carried));
  const subtrees = ordered.map((run, i) => planChild(planning, region, run, matches[i]));
  return { node: region.node, files, subtrees };
};

const startPlanning = (entries: ReadonlyArray<IndexEntry>, carried: CacheTreeEntry | undefined) => {
  const drafts: Drafts = {
    names: [],
    counts: [],
    reused: [],
    previous: [],
    invalid: [],
    children: [],
  };
  const badBefore = badEntriesBefore(entries);
  const invalid = (badBefore[entries.length] as number) > 0;
  addNode(drafts, new Uint8Array(0), entries.length, invalid);
  const planning: Planning = {
    entries,
    paths: entries.map(pathBytesOf),
    badBefore,
    drafts,
    regions: [],
  };
  const root = { node: ROOT, start: 0, end: entries.length, prefixLength: 0 };
  const reused = reusableId(carried, entries.length, invalid);
  if (carried !== undefined && reused !== undefined) {
    drafts.reused[ROOT] = reused;
    mirrorCarried(drafts, ROOT, carried);
  } else planning.regions.push({ ...root, carried: carried?.children ?? NO_CARRIED });
  return planning;
};

export const planCacheTree = (
  entries: ReadonlyArray<IndexEntry>,
  carried: CacheTreeEntry | undefined,
): CacheTreePlan => {
  const sorted = isIndexOrdered(entries) ? entries : [...entries].sort(pathComparatorFor(entries));
  const planning = startPlanning(sorted, carried);
  const visited: TreeBuild[] = [];
  for (let region = planning.regions.pop(); region !== undefined; region = planning.regions.pop()) {
    visited.push(expand(planning, region));
  }
  const { drafts } = planning;
  const nodes = drafts.names.map((nameBytes, i) => ({
    nameBytes,
    entryCount: drafts.counts[i] as number,
    ...(drafts.reused[i] === undefined ? {} : { reused: drafts.reused[i] as ObjectId }),
    ...(drafts.previous[i] === undefined ? {} : { previousId: drafts.previous[i] as ObjectId }),
    invalid: drafts.invalid[i] as boolean,
    children: drafts.children[i] as number[],
  }));
  return { nodes, builds: visited.reverse() };
};

export const cacheTreeNodesOf = (
  plan: CacheTreePlan,
  ids: ReadonlyArray<ObjectId | undefined>,
): CacheTreeEntry[] => {
  const entries: CacheTreeEntry[] = [];
  for (let i = plan.nodes.length - 1; i >= 0; i--) {
    const node = plan.nodes[i] as PlannedNode;
    const id = node.invalid ? undefined : ids[i];
    const { path, pathBytes } = indexPathOfBytes(node.nameBytes);
    entries[i] = {
      path,
      ...(pathBytes === undefined ? {} : { nameBytes: pathBytes }),
      entryCount: id === undefined ? -1 : node.entryCount,
      subtreeCount: node.children.length,
      ...(id === undefined ? {} : { id }),
      children: node.children.map((child) => entries[child] as CacheTreeEntry),
    };
  }
  return entries;
};

export const toCacheTreeEntry = (
  plan: CacheTreePlan,
  ids: ReadonlyArray<ObjectId | undefined>,
): CacheTreeEntry => cacheTreeNodesOf(plan, ids)[ROOT] as CacheTreeEntry;
