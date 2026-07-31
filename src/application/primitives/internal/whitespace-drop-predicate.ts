/**
 * Drop-pass predicate for the whitespace/CR-at-eol diff modes.
 *
 * Answers "does any significant change survive normalization?" for one
 * `modify` change, over one of two arms selected per blob by
 * `openBlobSource`'s buffered/streamed gate (`blob-source.ts`):
 *  - `compareBuffered` — both blobs resolve under the gate: fully
 *    synchronous, zero promises, zero stream machinery.
 *  - `compareStreamed` — at least one blob resolves over the gate: today's
 *    concurrent advance-both-sides loop, now consulting the synchronous
 *    scanner first and only awaiting a side that actually needs a chunk.
 *
 * Both arms drive the same `LineDigestScanner` (`line-digest-scanner.ts`)
 * and share one verdict ladder (`applyLadder`), so "identical semantics"
 * holds by construction rather than by two independently maintained copies.
 */
import type { ModifyChange } from '../../../domain/diff/diff-change.js';
import {
  createLineDigestScanner,
  type LineDigestScanner,
  type ScanStep,
} from '../../../domain/diff/line-digest-scanner.js';
import { digestsEqual, type LineKey } from '../../../domain/diff/whitespace.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type BlobSource, MAX_BUFFERED_BLOB_BYTES, openBlobSource } from './blob-source.js';

// The seam only REPORTS type; the blob-only refusal is this caller's concern
// (mirrors streamBlob's own wrap-tail check). `type` is `undefined` only on
// the loose streamed arm, where refusal stays lazy, on first drain.
function refuseNonBlob(id: ObjectId, source: BlobSource): void {
  if (source.type !== undefined && source.type !== 'blob') {
    throw unexpectedObjectType('blob', source.type, id);
  }
}

type LadderVerdict = boolean | 'continue';

/**
 * The shared verdict ladder both arms drive. Binary precedes the digest
 * comparison on purpose (an emitted-then-flagged line must never let a
 * `true` verdict slip through before the flag is observed).
 */
function applyLadder(
  oldScanner: LineDigestScanner,
  newScanner: LineDigestScanner,
  oldStep: ScanStep,
  newStep: ScanStep,
): LadderVerdict {
  if (oldScanner.binary || newScanner.binary) {
    return false;
  }
  const oldDigest = oldStep.kind === 'digest' ? oldStep.digest : undefined;
  const newDigest = newStep.kind === 'digest' ? newStep.digest : undefined;
  if (oldDigest === undefined && newDigest === undefined) return true;
  if (oldDigest === undefined || newDigest === undefined) return false;
  if (!digestsEqual(oldDigest, newDigest)) return false;
  return 'continue';
}

/** Fully synchronous: both sides are already resident, so the whole
 *  comparison is one pass over each scanner with zero promises. */
function compareBuffered(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
): boolean {
  const oldScanner = createLineDigestScanner(lineKey, ignoreBlankLines);
  const newScanner = createLineDigestScanner(lineKey, ignoreBlankLines);
  oldScanner.push(oldContent);
  oldScanner.end();
  newScanner.push(newContent);
  newScanner.end();

  for (;;) {
    const verdict = applyLadder(oldScanner, newScanner, oldScanner.next(), newScanner.next());
    if (verdict !== 'continue') return verdict;
  }
}

/** One side of a streamed comparison: a scanner plus the iterator that feeds
 *  it — present only when the side actually streams. A buffered side is
 *  pushed and ended up front and carries no iterator, so it is never
 *  awaited: `advanceSide` only calls into the iterator a side actually has. */
interface ScanSide {
  readonly scanner: LineDigestScanner;
  readonly iterator?: AsyncIterator<Uint8Array>;
}

function createScanSide(source: BlobSource, lineKey: LineKey, ignoreBlankLines: boolean): ScanSide {
  const scanner = createLineDigestScanner(lineKey, ignoreBlankLines);
  if (source.kind === 'bytes') {
    scanner.push(source.content);
    scanner.end();
    return { scanner };
  }
  return { scanner, iterator: source.stream[Symbol.asyncIterator]() };
}

async function advanceSide(side: ScanSide): Promise<ScanStep> {
  let step = side.scanner.next();
  while (step.kind === 'needs-input' && side.iterator !== undefined) {
    const chunk = await side.iterator.next();
    if (chunk.done === true) {
      side.scanner.end();
    } else {
      side.scanner.push(chunk.value);
    }
    step = side.scanner.next();
  }
  return step;
}

// Resource hygiene (worth 0ms, landed for the reader/inflate-instance leak
// it closes, not as a perf lever): releases a streamed side's iterator so
// readableStreamToAsyncIterable cancels the reader instead of leaking it
// until GC. A buffered side has no iterator, so this is a no-op for it.
async function releaseSide(side: ScanSide): Promise<void> {
  await side.iterator?.return?.();
}

/** Keeps today's structure and concurrency: both sides advance under one
 *  `Promise.all` per step, so a two-large-blob diff still overlaps its I/O.
 *  A side that resolved buffered never touches its iterator, so the mixed
 *  case never allocates or awaits a resolved promise for it per line. */
async function compareStreamed(
  oldSrc: BlobSource,
  newSrc: BlobSource,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
): Promise<boolean> {
  const oldSide = createScanSide(oldSrc, lineKey, ignoreBlankLines);
  const newSide = createScanSide(newSrc, lineKey, ignoreBlankLines);

  for (;;) {
    const [oldStep, newStep] = await Promise.all([advanceSide(oldSide), advanceSide(newSide)]);
    const verdict = applyLadder(oldSide.scanner, newSide.scanner, oldStep, newStep);
    if (verdict !== 'continue') {
      await Promise.all([releaseSide(oldSide), releaseSide(newSide)]);
      return verdict;
    }
  }
}

/**
 * `true` when `change` has zero significant lines added/deleted under `key`
 * (and `ignoreBlankLines`) — the drop-pass equivalent of `shouldDrop` fed by
 * `computeStatFields`. A binary side (NUL-in-window) is never dropped.
 *
 * `maxBufferedBytes` selects, per blob, whether it resolves buffered or
 * streamed (see `openBlobSource`); it defaults to the library-wide
 * buffered-blob gate and the production call site never overrides it.
 */
export async function isWhitespaceOnlyModify(
  ctx: Context,
  change: ModifyChange,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
  maxBufferedBytes: number = MAX_BUFFERED_BLOB_BYTES,
): Promise<boolean> {
  const [oldSrc, newSrc] = await Promise.all([
    openBlobSource(ctx, change.oldId, maxBufferedBytes),
    openBlobSource(ctx, change.newId, maxBufferedBytes),
  ]);
  refuseNonBlob(change.oldId, oldSrc);
  refuseNonBlob(change.newId, newSrc);

  if (oldSrc.kind === 'bytes' && newSrc.kind === 'bytes') {
    return compareBuffered(oldSrc.content, newSrc.content, lineKey, ignoreBlankLines);
  }
  return await compareStreamed(oldSrc, newSrc, lineKey, ignoreBlankLines);
}
