/**
 * Shared corpus for the index-pass equivalence net (`fetch-pack.test.ts`'s
 * "index pass equivalence" suite): one factory per accepting row of the
 * design's degenerate-input table, plus the deep-chain and branching-forest
 * shapes later parts depend on. A factory, not a plain array, because the
 * REF-delta cases need a `baseId` computed from the context's own hash
 * before the entries can be built.
 */
import { DISK_WALK_WINDOW_BYTES } from '../../../../src/application/primitives/internal/index-pack.js';
import type { Context } from '../../../../src/ports/context.js';
import type { BaseEntrySpec, EntrySpec } from './pack-fixture.js';

const ENCODER = new TextEncoder();

/**
 * Deterministic pseudo-random bytes (xorshift32) — deflate cannot meaningfully
 * compress this, so a blob built from it produces a compressed pack entry
 * whose size tracks `length` almost 1:1. Copied from `fetch-pack.test.ts`'s
 * own helper (11 lines) rather than shared, per the plan for this corpus.
 */
const pseudoRandomBytes = (length: number, seed: number): Uint8Array => {
  let state = seed >>> 0 || 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
};

/**
 * Computes a blob's loose object id independently of the indexer under
 * test — needed up front so a REF_DELTA entry spec can declare its base's
 * id before the base entry itself is built.
 */
const blobId = async (ctx: Context, content: Uint8Array): Promise<string> => {
  const header = ENCODER.encode(`blob ${content.length}\0`);
  const loose = new Uint8Array(header.length + content.length);
  loose.set(header, 0);
  loose.set(content, header.length);
  return ctx.hash.hashHex(loose);
};

/**
 * A linear chain: one base blob, then `depth` OFS deltas each chained onto
 * the immediately preceding entry. Each level's target is its parent's
 * content plus one byte, so `encodeDeltaFromScratch` (the fixture builder's
 * own delta encoder) runs once per level.
 */
const buildOfsChain = (depth: number): EntrySpec[] => {
  const base: BaseEntrySpec = { kind: 'base', type: 'blob', content: new Uint8Array([0]) };
  const entries: EntrySpec[] = [base];
  let previousContent = base.content;
  for (let level = 0; level < depth; level += 1) {
    const targetContent = new Uint8Array(previousContent.length + 1);
    targetContent.set(previousContent, 0);
    targetContent[previousContent.length] = level & 0xff;
    entries.push({ kind: 'ofs-delta', baseIndex: entries.length - 1, targetContent });
    previousContent = targetContent;
  }
  return entries;
};

/**
 * One base with three OFS-delta children, each with one child of its own —
 * the shape the retained-ancestor release rule (later parts) depends on:
 * the base must stay resolvable until all three children have resolved.
 */
const buildBranchingForest = (): EntrySpec[] => {
  const baseContent = ENCODER.encode('branching-forest base content');
  const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
  for (let child = 0; child < 3; child += 1) {
    const childContent = new Uint8Array(baseContent.length + 1);
    childContent.set(baseContent, 0);
    childContent[baseContent.length] = child;
    entries.push({ kind: 'ofs-delta', baseIndex: 0, targetContent: childContent });
    const childIndex = entries.length - 1;
    const grandchildContent = new Uint8Array(childContent.length + 1);
    grandchildContent.set(childContent, 0);
    grandchildContent[childContent.length] = 0xff;
    entries.push({ kind: 'ofs-delta', baseIndex: childIndex, targetContent: grandchildContent });
  }
  return entries;
};

const MULTI_WINDOW_ENTRY_COUNT = 12;
const MULTI_WINDOW_ENTRY_BYTES = 60_000;

export interface IndexPassCorpusCase {
  readonly name: string;
  readonly entries: (ctx: Context) => Promise<EntrySpec[]>;
}

export const INDEX_PASS_CORPUS: ReadonlyArray<IndexPassCorpusCase> = [
  { name: 'empty-pack', entries: async () => [] },
  {
    name: 'single-base',
    entries: async () => [
      { kind: 'base', type: 'blob', content: ENCODER.encode('single-base blob content') },
    ],
  },
  {
    name: 'base-then-ofs-delta',
    entries: async () => [
      { kind: 'base', type: 'blob', content: ENCODER.encode('ofs-delta base content') },
      {
        kind: 'ofs-delta',
        baseIndex: 0,
        targetContent: ENCODER.encode('ofs-delta target content'),
      },
    ],
  },
  {
    name: 'base-then-ref-delta',
    entries: async (ctx) => {
      const baseContent = ENCODER.encode('ref-delta base content');
      const baseId = await blobId(ctx, baseContent);
      return [
        { kind: 'base', type: 'blob', content: baseContent },
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent: ENCODER.encode('ref-delta target content'),
        },
      ];
    },
  },
  {
    name: 'ref-delta-before-base',
    entries: async (ctx) => {
      const baseContent = ENCODER.encode('ref-delta-before-base base content');
      const baseId = await blobId(ctx, baseContent);
      return [
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent: ENCODER.encode('ref-delta-before-base target content'),
        },
        { kind: 'base', type: 'blob', content: baseContent },
      ];
    },
  },
  { name: 'ofs-chain-depth-1', entries: async () => buildOfsChain(1) },
  { name: 'ofs-chain-depth-50', entries: async () => buildOfsChain(50) },
  { name: 'ofs-chain-depth-1000', entries: async () => buildOfsChain(1000) },
  {
    name: 'zero-length-object',
    entries: async () => [{ kind: 'base', type: 'blob', content: new Uint8Array(0) }],
  },
  {
    name: 'duplicate-oid',
    entries: async () =>
      Array.from({ length: 4 }, () => ({
        kind: 'base' as const,
        type: 'blob' as const,
        content: new Uint8Array(0),
      })),
  },
  {
    name: 'multi-window',
    entries: async () =>
      Array.from({ length: MULTI_WINDOW_ENTRY_COUNT }, (_, i) => ({
        kind: 'base' as const,
        type: 'blob' as const,
        content: pseudoRandomBytes(MULTI_WINDOW_ENTRY_BYTES, 5000 + i),
      })),
  },
  {
    name: 'entry-larger-than-window',
    entries: async () => [
      {
        kind: 'base',
        type: 'blob',
        content: pseudoRandomBytes(DISK_WALK_WINDOW_BYTES * 2 + 1, 424_242),
      },
    ],
  },
  { name: 'branching-forest', entries: async () => buildBranchingForest() },
];
