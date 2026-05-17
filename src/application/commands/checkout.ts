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

  // Read target tree
  const target = await readTree(ctx, oid);
  const currentIndex = await readIndex(ctx);

  // Materialize working tree
  const materializeResult = await materializeTree(ctx, {
    targetTree: target.id,
    currentIndex,
    force: opts.force ?? false,
  });

  // Commit new index
  if (materializeResult.written > 0 || materializeResult.deleted > 0) {
    const lock = await acquireIndexLock(ctx);
    try {
      await lock.commit(materializeResult.newIndexEntries);
    } catch (err) {
      await lock.release();
      throw err;
    }
  }

  // Move HEAD
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
  const currentIndex = await readIndex(ctx);
  const pathSet = new Set(opts.paths.map((p) => p as FilePath));

  const materializeResult = await materializeTree(ctx, {
    targetTree,
    currentIndex,
    force: true,
    paths: pathSet,
  });

  // Path-restore only commits the index when the source diverged from the
  // current index. When source === 'index', the index is the authoritative
  // truth and we don't rewrite it.
  if (source !== 'index' && (materializeResult.written > 0 || materializeResult.deleted > 0)) {
    const lock = await acquireIndexLock(ctx);
    try {
      await lock.commit(materializeResult.newIndexEntries);
    } catch (err) {
      await lock.release();
      throw err;
    }
  }

  // HEAD unchanged. Resolve current HEAD for the result.
  const head = await resolveRef(ctx, 'HEAD' as RefName);
  return {
    branch: undefined,
    id: head,
    detached: false,
    changedPaths: materializeResult.written + materializeResult.deleted,
  };
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
