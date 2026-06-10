import fc from 'fast-check';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

/**
 * Shared property-test arbitraries for the application/primitives family.
 *
 * Commit-DAG generators for merge-base properties: a `DagSpec` is a
 * topologically-ordered node list where node `i` may only parent earlier
 * indices, so every generated graph is acyclic by construction.
 */

/**
 * Characters that exercise every grammar branch of the subsection writer/reader:
 * mandatory escape targets (`\`, `"`), raw-emitted but structurally sensitive
 * chars (`]`, CR), and comment triggers (`#`, `;`).
 */
const SUBSECTION_SPECIAL_CHARS = [
  '"', // must be escaped to `\"`
  '\\', // must be escaped to `\\` (first)
  ']', // written raw inside quotes — would break an unquoted header
  '\r', // CR — written raw inside quotes, round-trips
  '#', // comment trigger — written raw inside quotes
  ';', // comment trigger — written raw inside quotes
  ' ', // space — ordinary inside a quoted subsection
  '\t', // TAB — ordinary content inside a quoted subsection
  '\x01', // C0 control — passed through raw
  '\x7f', // DEL — passed through raw
];

/**
 * Single character arbitrary biased toward subsection-grammar-exercising
 * special chars plus ordinary printable ASCII.
 * Excludes LF (`\n`) and NUL (`\0`) — the two chars git rejects.
 */
const arbSubsectionUnit = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom(...SUBSECTION_SPECIAL_CHARS),
    fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
  );

/**
 * Generator over the full LF/NUL-free subsection-name domain (up to 1024 chars).
 * Includes the empty string. Combines a wide full-unicode generator (with LF and
 * NUL stripped) and a specials-biased generator so shrunk counterexamples stay
 * readable and grammar branch coverage is high.
 */
export const subsectionName = (): fc.Arbitrary<string> => {
  // Wide: full unicode with LF and NUL stripped.
  const wide = fc.string({ unit: 'binary', maxLength: 1024 }).map((s) => s.replace(/[\n\0]/g, ''));

  // Biased: strings built from grammar-exercising specials + printable ASCII.
  const biased = fc.string({ unit: arbSubsectionUnit(), maxLength: 1024 });

  return fc.oneof(wide, biased);
};

export interface DagNodeSpec {
  readonly parents: readonly number[];
  readonly ts: number;
}

export type DagSpec = readonly DagNodeSpec[];

export const dagSpecArb = (
  options: { readonly maxNodes?: number; readonly maxFanIn?: number } = {},
): fc.Arbitrary<DagSpec> => {
  const maxNodes = options.maxNodes ?? 8;
  const maxFanIn = options.maxFanIn ?? 3;
  return fc.integer({ min: 1, max: maxNodes }).chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_unused, i) =>
        fc.record({
          parents:
            i === 0
              ? fc.constant<number[]>([])
              : fc.uniqueArray(fc.integer({ min: 0, max: i - 1 }), {
                  maxLength: Math.min(maxFanIn, i),
                }),
          ts: fc.integer({ min: 1, max: 1_000_000 }),
        }),
      ),
    ),
  );
};

const AUTHOR: AuthorIdentity = {
  name: 'Prop',
  email: 'p@p.com',
  timestamp: 1,
  timezoneOffset: '+0000',
};

const emptyTreeId = async (ctx: Context): Promise<ObjectId> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
};

/** Materialise a `DagSpec` into real commits; index `i` maps to the returned oid `i`. */
export const buildDag = async (ctx: Context, spec: DagSpec): Promise<ObjectId[]> => {
  const treeId = await emptyTreeId(ctx);
  const ids: ObjectId[] = [];
  for (let i = 0; i < spec.length; i += 1) {
    const parents = spec[i]!.parents.map((p) => ids[p]!);
    const id = await createCommit(ctx, {
      tree: treeId,
      parents,
      author: { ...AUTHOR, timestamp: spec[i]!.ts },
      committer: { ...AUTHOR, timestamp: spec[i]!.ts },
      // index disambiguates so distinct nodes never collide to one oid
      message: `node-${i}`,
    });
    ids.push(id);
  }
  return ids;
};

/** Indices reachable from `i` (inclusive) — independent transitive-closure oracle. */
export const ancestorIndices = (spec: DagSpec, i: number): Set<number> => {
  const seen = new Set<number>([i]);
  const stack = [i];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const parent of spec[node]!.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return seen;
};

/** Best common ancestors of two node indices, computed via full ancestor sets. */
export const oracleBaseIndices = (spec: DagSpec, a: number, b: number): number[] => {
  const ancA = ancestorIndices(spec, a);
  const ancB = ancestorIndices(spec, b);
  const common = [...ancA].filter((x) => ancB.has(x));
  const closures = new Map(common.map((c) => [c, ancestorIndices(spec, c)]));
  return common.filter((x) => !common.some((y) => y !== x && closures.get(y)!.has(x)));
};
