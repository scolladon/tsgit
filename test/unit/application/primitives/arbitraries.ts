import fc from 'fast-check';

import { tokenizeConfig } from '../../../../src/application/primitives/config-read.js';
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

// ---------------------------------------------------------------------------
// Config-file generators for surgery-preservation property tests
// ---------------------------------------------------------------------------

/**
 * Characters valid inside a config value that the tokenizer handles as
 * plain content — excludes `\`, `"`, `#`, `;` (comment triggers), and
 * leading/trailing space (so generated values never need quoting and are
 * always tokenized as single-line entries).
 */
const CONFIG_VALUE_CHARS = fc.integer({ min: 0x21, max: 0x7e }).map((cp) => {
  const ch = String.fromCodePoint(cp);
  if (ch === '\\' || ch === '"' || ch === '#' || ch === ';') return 'x';
  return ch;
});

/**
 * A grammar-safe config value: 1–12 printable ASCII chars with no special
 * characters that would trigger quoting or comment parsing.
 */
const arbSafeValue = (): fc.Arbitrary<string> =>
  fc.string({ unit: CONFIG_VALUE_CHARS, minLength: 1, maxLength: 12 });

/**
 * A valid config key: first char alpha, rest alnum or dash, length 1–8.
 * Kept short so collision probability between generated blocks is meaningful.
 */
export const arbConfigKey = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)), // a–z
      fc.array(
        fc.oneof(
          fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)),
          fc.integer({ min: 0x30, max: 0x39 }).map((cp) => String.fromCodePoint(cp)),
          fc.constant('-'),
        ),
        { minLength: 0, maxLength: 7 },
      ),
    )
    .map(([first, rest]) => first + rest.join(''));

/** Section names drawn from a small pool so duplicate-block cases occur. */
const ARB_SECTIONS = ['a', 'b', 'zed'] as const;

/** Subsections: empty string (no subsection) or a short alnum string. */
const arbSubsectionOrNone = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant(undefined),
    fc
      .string({
        unit: fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)),
        minLength: 1,
        maxLength: 4,
      })
      .map((s) => s),
  );

/**
 * A single body item: one of —
 *  - single-line valued entry
 *  - valueless entry
 *  - multi-line entry (head + 1–2 continuation tails, including key-lookalike
 *    and header-lookalike tails, to exercise K/L-style misclassification guards)
 *  - comment line
 *  - blank line
 *
 * Values use `arbSafeValue` so `tokenizeConfig` is total over the generated text.
 */
const arbBodyItem = (): fc.Arbitrary<string> =>
  fc.oneof(
    // single-line valued entry
    fc.tuple(arbConfigKey(), arbSafeValue()).map(([k, v]) => `\t${k} = ${v}\n`),
    // valueless entry
    arbConfigKey().map((k) => `\t${k}\n`),
    // multi-line entry: head line + 1 or 2 tail lines
    fc
      .tuple(
        arbConfigKey(),
        arbSafeValue(),
        fc.oneof(
          // plain continuation tail
          arbSafeValue().map((v) => `   ${v}\n`),
          // key-lookalike tail (exercises K-case: looks like `url = fake`)
          fc.tuple(arbConfigKey(), arbSafeValue()).map(([k, v]) => `\t${k} = ${v}\n`),
          // header-lookalike tail (exercises L-case: looks like `[section]`)
          fc.constantFrom('[lookalike]', '[b]', '[zed "x"]').map((h) => `${h}\n`),
        ),
        // optional bare mid value — when present the entry chains two tails
        fc.option(arbSafeValue(), { nil: undefined }),
      )
      .map(([k, v, finalTail, midValue]) => {
        const head = `\t${k} = ${v}`;
        if (midValue !== undefined) {
          // two tails: head\<LF>   mid\<LF>finalTail<LF>
          return `${head}\\\n   ${midValue}\\\n${finalTail}`;
        }
        // one tail: head\<LF>finalTail<LF>
        return `${head}\\\n${finalTail}`;
      }),
    // comment line
    fc.constantFrom('# a comment\n', '; another comment\n'),
    // blank line
    fc.constant('\n'),
  );

/** A complete `[section]` or `[section "sub"]` header line. */
const arbHeader = (): fc.Arbitrary<{
  readonly text: string;
  readonly section: string;
  readonly subsection: string | undefined;
}> =>
  fc
    .tuple(fc.constantFrom(...ARB_SECTIONS), arbSubsectionOrNone())
    .map(([section, subsection]) => ({
      text: subsection !== undefined ? `[${section} "${subsection}"]\n` : `[${section}]\n`,
      section,
      subsection,
    }));

/**
 * Arbitrary of one config block: a header followed by 0–4 body items.
 * Section names from `ARB_SECTIONS` so collisions (duplicate blocks) occur.
 */
export const configEntryBlock = (): fc.Arbitrary<string> =>
  fc
    .tuple(arbHeader(), fc.array(arbBodyItem(), { minLength: 0, maxLength: 4 }))
    .map(([header, items]) => header.text + items.join(''));

/**
 * Arbitrary of one same-line block: a header carrying a `key = value` (or
 * valueless `key`) on its own physical line, followed by 0–3 body items.
 * Models git's `[s] key = v` form, which the writer must split on replace and
 * prune on unset while leaving the head verbatim for unrelated operations.
 */
export const configFileWithSameLineBlock = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...ARB_SECTIONS),
      arbConfigKey(),
      fc.option(arbSafeValue(), { nil: undefined }),
      fc.array(arbBodyItem(), { minLength: 0, maxLength: 3 }),
    )
    .map(([section, key, value, items]) => {
      const head =
        value === undefined ? `[${section}] ${key}\n` : `[${section}] ${key} = ${value}\n`;
      return head + items.join('');
    });

/**
 * Arbitrary of a complete LF-terminated config file: 1–4 blocks concatenated.
 * Always ends with `\n` (the last block item always terminates with LF).
 */
export const configFile = (): fc.Arbitrary<string> =>
  fc.array(configEntryBlock(), { minLength: 1, maxLength: 4 }).map((blocks) => blocks.join(''));

/**
 * Like `configFile`, but each block is independently chosen to be either a
 * plain block or a same-line block (`[s] key = v`), so surgery-preservation
 * properties also exercise the header-split path. Always LF-terminated.
 */
export const configFileMaybeSameLine = (): fc.Arbitrary<string> =>
  fc
    .array(fc.oneof(configEntryBlock(), configFileWithSameLineBlock()), {
      minLength: 1,
      maxLength: 4,
    })
    .map((blocks) => blocks.join(''));

/**
 * A config file plus an operation target whose section comes from the same
 * pool the blocks draw from and whose key is biased (3:1) toward keys already
 * present in the file, so surgery properties exercise the existing-entry
 * paths (multi-line replace/remove, orphan-tail detection) on most runs
 * instead of degenerating to insert-new/no-op.
 */
export const configFileWithTarget = (): fc.Arbitrary<{
  readonly file: string;
  readonly section: string;
  readonly key: string;
}> =>
  configFileMaybeSameLine().chain((file) => {
    const presentKeys = [
      ...new Set(
        tokenizeConfig(file).flatMap((t) => (t.kind === 'entry' && t.key !== '' ? [t.key] : [])),
      ),
    ];
    const key =
      presentKeys.length === 0
        ? arbConfigKey()
        : fc.oneof(
            { weight: 3, arbitrary: fc.constantFrom(...presentKeys) },
            { weight: 1, arbitrary: arbConfigKey() },
          );
    return fc.record({
      file: fc.constant(file),
      section: fc.constantFrom(...ARB_SECTIONS),
      key,
    });
  });

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

/**
 * Arbitrary over the three canonical subsection identities: undefined (plain
 * section, e.g. [s]), empty string (empty subsection, e.g. [s ""]), and a
 * short alphanumeric subsection name (e.g. [s "x"]). Used only in the
 * identity-isolation property; deliberately not mixed into arbSubsectionOrNone
 * to avoid poisoning existing surgery-preservation oracle queries.
 */
export const subsectionIdentity = (): fc.Arbitrary<string | undefined> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.string({
      unit: fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)),
      minLength: 1,
      maxLength: 4,
    }),
  );

/**
 * Arbitrary over `(section, subsection)` header identities plus the dotted
 * name that addresses them in section ops: section from a safe pool ∪ ''
 * (empty section only with a subsection present), subsection from
 * {undefined, ''} ∪ subsectionName(). The dotted name mirrors git's raw
 * header reduction (section alone, or section + '.' + subsection).
 */
export const arbHeaderIdentity = (): fc.Arbitrary<{
  section: string;
  subsection: string | undefined;
  dottedName: string;
}> => {
  const arbSection = fc.constantFrom('s', 'remote', 'core', 'a', '');
  const arbSub = fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    subsectionName().filter((s) => s !== ''),
  );
  return fc
    .tuple(arbSection, arbSub)
    .filter(
      // empty section is only representable with a subsection present
      ([section, sub]) => !(section === '' && sub === undefined),
    )
    .map(([section, subsection]) => ({
      section,
      subsection,
      dottedName: subsection === undefined ? section : `${section}.${subsection}`,
    }));
};
