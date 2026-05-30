/**
 * The `refs/stash` stack lives in that ref's reflog (newest entry =
 * `stash@{0}`). This primitive owns the stack's I/O:
 *
 * - **push** writes the ref AND force-appends the reflog entry directly,
 *   bypassing the `shouldAutocreateReflog` gate — `refs/stash` is not in the
 *   default-loggable set, but git always logs it (it passes the reflog-creation
 *   flag explicitly), so a plain `updateRef` would silently drop the first
 *   entry and destroy the stack before it exists.
 * - **drop** rewrites the stack in place: it removes one reflog line, repairs
 *   the following entry's `oldId` chain (git's `--rewrite`), and repoints
 *   `refs/stash` to the new tip — or deletes the ref + reflog when the stack
 *   empties (git's `--updateref`). It must NOT route through `updateRef`, which
 *   would append a fresh entry rather than rewrite.
 *
 * The selector is the numeric stack index (0 = newest); resolution is a direct
 * reflog read, not the shared rev-parse DWIM ladder.
 */
import { stashNotFound } from '../../domain/commands/error.js';
import { type ObjectId, type RefName, ZERO_OID } from '../../domain/objects/index.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { sanitizeReflogMessage } from '../../domain/reflog/reflog-format.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteRef } from './atomic-write.js';
import { looseRefPath } from './path-layout.js';
import { getRefStore } from './ref-store.js';
import { resolveReflogIdentity } from './reflog-identity.js';
import { appendReflog, deleteReflog, readReflog, writeReflog } from './reflog-store.js';

const STASH_REF = 'refs/stash' as RefName;

/** One entry of the stash stack, newest-first (`stash@{0}` = index 0). */
export interface StashStackEntry {
  readonly index: number;
  readonly selector: string;
  readonly stash: ObjectId;
  readonly message: string;
}

const REF_ENCODER = new TextEncoder();

/** The current `refs/stash` tip oid, or `ZERO_OID` when the ref is absent. */
const currentTip = async (ctx: Context): Promise<ObjectId> => {
  const result = await getRefStore(ctx).resolveDirect(STASH_REF);
  return result.kind === 'direct' ? result.id : ZERO_OID;
};

const writeStashRef = (ctx: Context, oid: ObjectId): Promise<void> =>
  atomicWriteRef(
    ctx,
    STASH_REF,
    looseRefPath(ctx.layout.gitDir, STASH_REF),
    REF_ENCODER.encode(`${oid}\n`),
  );

/** Read the stash stack newest-first. Empty when `refs/stash` has no reflog. */
export const readStashStack = async (ctx: Context): Promise<ReadonlyArray<StashStackEntry>> => {
  const stored = await readReflog(ctx, STASH_REF);
  const last = stored.length - 1;
  return stored.map((_, index) => {
    const entry = stored[last - index] as ReflogEntry;
    return { index, selector: `stash@{${index}}`, stash: entry.newId, message: entry.message };
  });
};

/** Resolve `stash@{index}` to its W commit oid. Throws `STASH_NOT_FOUND` when out of range. */
export const resolveStashEntry = async (ctx: Context, index: number): Promise<ObjectId> => {
  const stored = await readReflog(ctx, STASH_REF);
  const entry = stored[stored.length - 1 - index];
  if (entry === undefined) throw stashNotFound(index, stored.length);
  return entry.newId;
};

/**
 * Push a new stash commit `w` onto the stack: write `refs/stash` and
 * force-append the reflog entry (the autocreate gate is bypassed on purpose —
 * see the module header).
 */
export const pushStashRef = async (ctx: Context, w: ObjectId, message: string): Promise<void> => {
  const oldId = await currentTip(ctx);
  await writeStashRef(ctx, w);
  const identity = await resolveReflogIdentity(ctx);
  await appendReflog(ctx, STASH_REF, {
    oldId,
    newId: w,
    identity,
    message: sanitizeReflogMessage(message),
  });
};

export interface StashDropResult {
  readonly dropped: ObjectId;
  readonly remaining: number;
}

/**
 * Drop `stash@{index}` from the stack. Repairs the following entry's `oldId`
 * chain, then repoints `refs/stash` to the new tip — or removes the ref + reflog
 * when the stack empties. Throws `STASH_NOT_FOUND` when out of range.
 */
export const dropStashEntry = async (ctx: Context, index: number): Promise<StashDropResult> => {
  const stored = await readReflog(ctx, STASH_REF);
  const filePos = stored.length - 1 - index;
  const removed = stored[filePos];
  if (removed === undefined) throw stashNotFound(index, stored.length);

  // git's `--rewrite`: the entry that followed the dropped one inherits its
  // `oldId` so the reflog's old→new chain stays contiguous.
  const following = stored[filePos + 1];
  const survivors = stored
    .filter((_, i) => i !== filePos)
    .map((entry) => (entry === following ? { ...entry, oldId: removed.oldId } : entry));

  if (survivors.length === 0) {
    await getRefStore(ctx).removeLoose(STASH_REF);
    await deleteReflog(ctx, STASH_REF);
    return { dropped: removed.newId, remaining: 0 };
  }
  // git's `--updateref`: repoint to the newest survivor (the last entry).
  const newTip = survivors[survivors.length - 1] as ReflogEntry;
  await writeStashRef(ctx, newTip.newId);
  await writeReflog(ctx, STASH_REF, survivors);
  return { dropped: removed.newId, remaining: survivors.length };
};
