/**
 * Drop-pass predicate for the whitespace/CR-at-eol diff modes.
 *
 * Answers "does any significant change survive normalization?" for one
 * `modify` change, over one of two arms selected per blob by
 * `openBlobSource`'s buffered/streamed gate (`blob-source.ts`):
 *  - buffered — both blobs resolve under the gate: `scanEqual`
 *    (`line-digest-scanner.ts`) runs fully synchronously, zero promises,
 *    zero stream machinery. The stat path's drop verdict calls the same
 *    `scanEqual`, so the two paths cannot answer differently.
 *  - `compareStreamed` — at least one blob resolves over the gate: today's
 *    concurrent advance-both-sides loop, now consulting the synchronous
 *    scanner first and only awaiting a side that actually needs a chunk.
 *
 * Both arms drive the same `LineDigestScanner` and share one verdict ladder
 * (`applyLadder`, `line-digest-scanner.ts`), so "identical semantics" holds
 * by construction rather than by two independently maintained copies.
 *
 * On BOTH arms the ladder's `true` is a digest verdict — evidence, never proof
 * (`LineDigest`). Nothing is dropped until it is confirmed against the real
 * normalized bytes: the buffered arm confirms inside `scanEqual` over blobs it
 * already holds, the streamed arm re-reads (`confirmStreamedEqual`).
 */
import type { ModifyChange } from '../../../domain/diff/diff-change.js';
import {
  applyLadder,
  createLineDigestScanner,
  type LineDigestScanner,
  type ScanStep,
  scanEqual,
} from '../../../domain/diff/line-digest-scanner.js';
import { type LineKey, normalizedIsBlank, normalizeLine } from '../../../domain/diff/whitespace.js';
import { bytesEqual } from '../../../domain/objects/encoding.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type BlobSource, MAX_BUFFERED_BLOB_BYTES, openBlobSource } from './blob-source.js';

const LF = 0x0a;
const EMPTY = new Uint8Array(0);

// The seam only REPORTS type; the blob-only refusal is this caller's concern
// (mirrors streamBlob's own wrap-tail check). `type` is `undefined` only on
// the loose streamed arm, where refusal stays lazy, on first drain.
function refuseNonBlob(id: ObjectId, source: BlobSource): void {
  if (source.type !== undefined && source.type !== 'blob') {
    throw unexpectedObjectType('blob', source.type, id);
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
      return side.scanner.next();
    }
    side.scanner.push(chunk.value);
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

/** Cancels a source nothing has iterated yet — the sibling-failed case, where
 *  the survivor would otherwise strand its inflate pipeline until GC. */
async function releaseSource(source: BlobSource): Promise<void> {
  if (source.kind === 'bytes') return;
  await source.release();
}

/** Releases a side that opened successfully; a side that rejected has nothing
 *  to release, and its rejection is already carried by the caller. */
async function releaseOpened(opened: Promise<BlobSource>): Promise<void> {
  await opened.then(releaseSource, () => undefined);
}

/** Opens both sides and applies the blob-only refusal under one failure
 *  handler, so neither a failed open nor a refused type can leave the other
 *  side's stream un-cancelled. `Promise.all` keeps today's error selection. */
async function openBothSources(
  ctx: Context,
  change: ModifyChange,
  maxBufferedBytes: number,
): Promise<readonly [BlobSource, BlobSource]> {
  const opened = [
    openBlobSource(ctx, change.oldId, maxBufferedBytes),
    openBlobSource(ctx, change.newId, maxBufferedBytes),
  ] as const;
  try {
    const sources = await Promise.all(opened);
    refuseNonBlob(change.oldId, sources[0]);
    refuseNonBlob(change.newId, sources[1]);
    return sources;
  } catch (error) {
    await Promise.all(opened.map(releaseOpened));
    throw error;
  }
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

  try {
    for (;;) {
      const [oldStep, newStep] = await Promise.all([advanceSide(oldSide), advanceSide(newSide)]);
      const verdict = applyLadder(oldSide.scanner, newSide.scanner, oldStep, newStep);
      if (verdict !== 'continue') return verdict;
    }
  } finally {
    // Also the abort / hash-mismatch / lazy-refusal path: a side that rejects
    // must not strand its sibling's reader.
    await Promise.all([releaseSide(oldSide), releaseSide(newSide)]);
  }
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  // NOTE: forcing this guard to `false` is equivalent — the copy below yields
  // the same bytes as `tail`, and no caller observes array identity, so only
  // the allocation differs. Left unannotated because the opposite variants
  // (`true`, `!==`) are real, killed mutants on this same line, and Stryker's
  // next-line disable matches by mutator+line, not by which variant.
  if (head.length === 0) return tail;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/** The source's bytes as chunks, whichever arm it resolved on. */
async function* sourceChunks(source: BlobSource): AsyncIterable<Uint8Array> {
  if (source.kind === 'bytes') {
    yield source.content;
    return;
  }
  yield* source.stream;
}

/** The line's normalized bytes, or `undefined` when the key does not count it. */
function significantOf(
  line: Uint8Array,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
): Uint8Array | undefined {
  const normalized = normalizeLine(line, lineKey);
  if (ignoreBlankLines && normalizedIsBlank(normalized)) return undefined;
  return normalized;
}

/**
 * One side's significant lines as normalized bytes, streamed. Splits on LF —
 * `splitLines`' own rule, re-derived here only because the source arrives in
 * chunks — so at most ONE line is ever resident, and a blob far past any
 * buffering gate is confirmed without being materialised.
 */
async function* significantLines(
  source: BlobSource,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
): AsyncIterable<Uint8Array> {
  let pending: Uint8Array = EMPTY;
  for await (const chunk of sourceChunks(source)) {
    let buffered = concatBytes(pending, chunk);
    for (let lf = buffered.indexOf(LF); lf !== -1; lf = buffered.indexOf(LF)) {
      const line = significantOf(buffered.subarray(0, lf + 1), lineKey, ignoreBlankLines);
      if (line !== undefined) yield line;
      buffered = buffered.subarray(lf + 1);
    }
    pending = buffered;
  }
  if (pending.length === 0) return;
  const last = significantOf(pending, lineKey, ignoreBlankLines);
  if (last !== undefined) yield last;
}

/**
 * Walks both sides' significant lines in lockstep, comparing normalized bytes.
 *
 * The one-sided `done` this handles cannot arise from its only caller: the
 * ladder answers `true` only when both scanners exhaust on the SAME step, and
 * `significantLines` yields exactly one line per digest the scanner emits, so
 * the two iterators always finish together. Every mutant that only changes how
 * a one-sided `done` is treated is therefore equivalent — the two that a
 * next-line disable can bind are annotated below; the `ConditionalExpression`
 * variants cannot be (killed siblings share their lines). The count check stays
 * regardless: this is a total predicate over the iterators it is handed, and
 * must not quietly depend on an invariant its caller happens to establish.
 */
async function linesAgree(
  oldLines: AsyncIterator<Uint8Array>,
  newLines: AsyncIterator<Uint8Array>,
): Promise<boolean> {
  for (;;) {
    const [oldLine, newLine] = await Promise.all([oldLines.next(), newLines.next()]);
    // Stryker disable next-line LogicalOperator: equivalent — both sides always finish on the same step, so `&&` enters this branch on exactly the steps `||` does.
    if (oldLine.done === true || newLine.done === true) {
      // Stryker disable next-line LogicalOperator: equivalent — reached only with both sides done, where `||` and `&&` both answer `true`.
      return oldLine.done === true && newLine.done === true;
    }
    if (!bytesEqual(oldLine.value, newLine.value)) return false;
  }
}

/**
 * Exact confirmation for the streamed arm's would-be-drop verdict. Re-opens
 * both blobs and compares their significant lines byte for byte — the one
 * thing the digests cannot establish (`applyLadder`). The re-read is the price
 * of not buffering: a streamed side is over the gate precisely because it does
 * not fit in memory, so materialising it to confirm would trade a silent
 * wrong answer for an unbounded allocation. Paid only when a change is about
 * to vanish from the diff; a "differs" verdict never reaches here.
 */
async function confirmStreamedEqual(
  ctx: Context,
  change: ModifyChange,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
  maxBufferedBytes: number,
): Promise<boolean> {
  const [oldSrc, newSrc] = await openBothSources(ctx, change, maxBufferedBytes);
  const oldLines = significantLines(oldSrc, lineKey, ignoreBlankLines)[Symbol.asyncIterator]();
  const newLines = significantLines(newSrc, lineKey, ignoreBlankLines)[Symbol.asyncIterator]();
  try {
    return await linesAgree(oldLines, newLines);
  } finally {
    await Promise.all([oldLines.return?.(), newLines.return?.()]);
  }
}

/**
 * `true` when `change` has zero significant lines added/deleted under `key`
 * (and `ignoreBlankLines`) — the streaming twin of the stat path's
 * `dropVerdict` (`diff-trees.ts`), which drives the same scanner and ladder.
 * A binary side (NUL-in-window) is never dropped.
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
  const [oldSrc, newSrc] = await openBothSources(ctx, change, maxBufferedBytes);

  if (oldSrc.kind === 'bytes' && newSrc.kind === 'bytes') {
    return scanEqual(oldSrc.content, newSrc.content, lineKey, ignoreBlankLines);
  }
  if (!(await compareStreamed(oldSrc, newSrc, lineKey, ignoreBlankLines))) return false;
  return await confirmStreamedEqual(ctx, change, lineKey, ignoreBlankLines, maxBufferedBytes);
}
