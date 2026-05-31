import { operationInProgress } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { bareRepository, notARepository } from '../../../domain/index.js';
import { type ObjectId, RefName } from '../../../domain/objects/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import { refNotFound } from '../../../domain/refs/error.js';
import { parseLooseRef } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';

const HEAD_REF = RefName.from('HEAD');

/** Discriminated union returned by `readHeadRaw`. */
export type HeadState =
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'direct'; readonly id: ObjectId };

/**
 * Confirm `ctx` points at a real repository: `${gitDir}/HEAD` exists.
 * Returns the repo root (workDir for non-bare; gitDir for bare repos where
 * gitDir IS the root).
 */
export const assertRepository = async (ctx: Context): Promise<FilePath> => {
  const headPath = `${ctx.layout.gitDir}/HEAD`;
  if (!(await ctx.fs.exists(headPath))) {
    throw notARepository(ctx.layout.workDir as FilePath);
  }
  const root = ctx.layout.bare ? ctx.layout.gitDir : ctx.layout.workDir;
  return root as FilePath;
};

/** Read `core.bare` from `.git/config`. Defaults to false when missing. */
export const isBare = async (ctx: Context): Promise<boolean> => {
  const config = await readConfig(ctx);
  return config.core?.bare ?? false;
};

/**
 * Throw `BARE_REPOSITORY` when the repo is bare, attaching `operation` so the
 * caller can surface "cannot <operation> on a bare repository".
 */
export const assertNotBare = async (ctx: Context, operation: string): Promise<void> => {
  if (await isBare(ctx)) {
    throw bareRepository(operation);
  }
};

/** Read and parse `.git/HEAD`. Missing → REF_NOT_FOUND. */
export const readHeadRaw = async (ctx: Context): Promise<HeadState> => {
  const path = `${ctx.layout.gitDir}/HEAD`;
  let content: string;
  try {
    content = await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') {
      throw refNotFound(HEAD_REF);
    }
    throw err;
  }
  const parsed = parseLooseRef(content);
  if (parsed.type === 'symbolic') {
    return { kind: 'symbolic', target: parsed.target };
  }
  return { kind: 'direct', id: parsed.target };
};

const PENDING_MARKERS: ReadonlyArray<{
  readonly file: string;
  readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
}> = [
  { file: 'MERGE_HEAD', operation: 'merge' },
  { file: 'CHERRY_PICK_HEAD', operation: 'cherry-pick' },
  { file: 'REVERT_HEAD', operation: 'revert' },
  { file: 'REBASE_HEAD', operation: 'rebase' },
];

type PendingOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/**
 * Reject mutations when an in-progress operation has left a marker file behind.
 * Catches the four standard markers; first match in PENDING_MARKERS order wins
 * (MERGE_HEAD beats the rest), but the existence checks fan out in parallel.
 *
 * Pass `except` (a single operation or a list) to skip those markers — used by
 * `commit` to allow the resolving commit of a conflicted merge / cherry-pick,
 * and by `add` to allow staging the resolution of any in-progress operation.
 */
export const assertNoPendingOperation = async (
  ctx: Context,
  options: { readonly except?: PendingOperation | ReadonlyArray<PendingOperation> } = {},
): Promise<void> => {
  const except = options.except;
  const isExcepted = (op: PendingOperation): boolean =>
    Array.isArray(except) ? except.includes(op) : except === op;
  const flags = await Promise.all(
    PENDING_MARKERS.map((m) => ctx.fs.exists(`${ctx.layout.gitDir}/${m.file}`)),
  );
  // Stryker disable next-line EqualityOperator: equivalent — relaxing the bound to `i <= length` adds one iteration at `i === PENDING_MARKERS.length`, where `PENDING_MARKERS[i]` is `undefined`; the `marker === undefined` guard below immediately `continue`s, so no extra check or throw occurs.
  for (let i = 0; i < PENDING_MARKERS.length; i += 1) {
    const marker = PENDING_MARKERS[i];
    if (marker === undefined) continue;
    if (isExcepted(marker.operation)) continue;
    if (flags[i] === true) throw operationInProgress(marker.operation);
  }
};
