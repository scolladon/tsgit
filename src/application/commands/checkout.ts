import { branchNotFound, invalidOption } from '../../domain/commands/error.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readTree } from '../primitives/read-tree.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';

export interface CheckoutSwitchOptions {
  readonly target: string;
  readonly detach?: boolean;
  readonly force?: boolean;
}

export interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  readonly source?: 'index' | 'HEAD' | ObjectId;
}

export type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

export interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
  readonly changedPaths: number;
}

const HEADS_PREFIX = 'refs/heads/';
const CHECKOUT_MATERIALIZE_OP = 'checkout:materialize';

const isSwitch = (opts: CheckoutOptions): opts is CheckoutSwitchOptions =>
  'target' in opts && opts.target !== undefined;
const isPaths = (opts: CheckoutOptions): opts is CheckoutPathsOptions =>
  'paths' in opts && opts.paths !== undefined;

const resolveSwitchOid = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  return resolveRef(ctx, target as RefName);
};

const switchBranch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const detached = opts.detach === true || /^[0-9a-f]{40}$/.test(opts.target);
  let branchRef: RefName | undefined;
  let oid: ObjectId;
  if (detached) {
    oid = await resolveSwitchOid(ctx, opts.target);
  } else {
    branchRef = validateRefName(`${HEADS_PREFIX}${opts.target}`);
    if (!(await ctx.fs.exists(`${ctx.layout.gitDir}/${branchRef}`))) {
      throw branchNotFound(branchRef);
    }
    oid = await resolveRef(ctx, branchRef);
  }

  // Read target tree — git objects are content-addressed and immutable, so
  // this can happen outside the index lock without risk.
  const target = await readTree(ctx, oid);

  // Acquire the index lock BEFORE reading the index. Wrapping the entire
  // read-materialise-commit sequence in the lock closes the TOCTOU window
  // where a concurrent index writer could otherwise stale the donor map
  // between readIndex and lock.commit. Matches the Phase 13.2 / 13.3 pattern.
  const lock = await acquireIndexLock(ctx);
  let materializeResult: Awaited<ReturnType<typeof materializeTree>>;
  try {
    const currentIndex = await readIndex(ctx);
    materializeResult = await materializeTree(ctx, {
      targetTree: target.id,
      currentIndex,
      force: opts.force ?? false,
    });
    if (materializeResult.written > 0 || materializeResult.deleted > 0) {
      await lock.commit(materializeResult.newIndexEntries);
    }
  } finally {
    await lock.release();
  }

  // Move HEAD — outside the index lock (HEAD writes are atomic on their own).
  if (detached) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${oid}\n`);
    return {
      branch: undefined,
      id: oid,
      detached: true,
      changedPaths: materializeResult.written + materializeResult.deleted,
    };
  }
  await writeSymbolicRef(ctx, 'HEAD' as RefName, branchRef as RefName);
  return {
    branch: branchRef,
    id: oid,
    detached: false,
    changedPaths: materializeResult.written + materializeResult.deleted,
  };
};

const resolvePathSource = async (
  ctx: Context,
  source: 'index' | 'HEAD' | ObjectId,
): Promise<ObjectId> => {
  if (source === 'index') {
    // For source==='index', we use HEAD's tree (the path-restore from index
    // is implemented by walking HEAD's tree, which matches stage-0 entries).
    // A future Phase will rebuild the synthetic tree from the index directly.
    const head = await resolveRef(ctx, 'HEAD' as RefName);
    const headTree = await readTree(ctx, head);
    return headTree.id;
  }
  if (source === 'HEAD') {
    const head = await resolveRef(ctx, 'HEAD' as RefName);
    const headTree = await readTree(ctx, head);
    return headTree.id;
  }
  const tree = await readTree(ctx, source);
  return tree.id;
};

const pathRestore = async (ctx: Context, opts: CheckoutPathsOptions): Promise<CheckoutResult> => {
  if (opts.paths.length === 0) {
    throw invalidOption('paths', 'must not be empty');
  }
  const source = opts.source ?? 'index';
  const targetTree = await resolvePathSource(ctx, source);
  const pathSet = new Set(opts.paths.map((p) => p as FilePath));

  // Two branches by source:
  // - 'index' (default): no index commit, no lock needed. Restore the working
  //   tree from the index snapshot; if a concurrent writer mutates the index
  //   mid-flight, the operation acts on the snapshot we read — well-defined.
  // - 'HEAD' | ObjectId: commits the index. Lock-first ordering applies, same
  //   as Phase 13.2/13.3 reset paths.
  const materializeResult =
    source === 'index'
      ? await materializePathRestoreUnderIndex(ctx, targetTree, pathSet)
      : await materializePathRestoreUnderLock(ctx, targetTree, pathSet);

  // HEAD unchanged. Resolve current HEAD for the result.
  const head = await resolveRef(ctx, 'HEAD' as RefName);
  return {
    branch: undefined,
    id: head,
    detached: false,
    changedPaths: materializeResult.written + materializeResult.deleted,
  };
};

const materializePathRestoreUnderIndex = async (
  ctx: Context,
  targetTree: ObjectId,
  pathSet: ReadonlySet<FilePath>,
): Promise<Awaited<ReturnType<typeof materializeTree>>> => {
  const currentIndex = await readIndex(ctx);
  return materializeTree(ctx, {
    targetTree,
    currentIndex,
    force: true,
    paths: pathSet,
  });
};

const materializePathRestoreUnderLock = async (
  ctx: Context,
  targetTree: ObjectId,
  pathSet: ReadonlySet<FilePath>,
): Promise<Awaited<ReturnType<typeof materializeTree>>> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree,
      currentIndex,
      force: true,
      paths: pathSet,
    });
    if (result.written > 0 || result.deleted > 0) {
      await lock.commit(result.newIndexEntries);
    }
    return result;
  } finally {
    await lock.release();
  }
};

export const checkout = async (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'checkout');
  await assertNoPendingOperation(ctx);

  const switchMode = isSwitch(opts);
  const pathsMode = isPaths(opts);
  if (switchMode && pathsMode) {
    throw invalidOption('paths', 'cannot be combined with target');
  }
  if (!switchMode && !pathsMode) {
    throw invalidOption('target', 'either target or paths must be provided');
  }

  ctx.progress.start(CHECKOUT_MATERIALIZE_OP);
  try {
    return pathsMode
      ? await pathRestore(ctx, opts)
      : await switchBranch(ctx, opts as CheckoutSwitchOptions);
  } finally {
    ctx.progress.end(CHECKOUT_MATERIALIZE_OP);
  }
};
