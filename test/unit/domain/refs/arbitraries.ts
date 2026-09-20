import fc from 'fast-check';
import type { RefName } from '../../../../src/domain/objects/index.js';
import type { PackedRefEntry } from '../../../../src/domain/refs/ref-types.js';
import { arbObjectId } from '../objects/arbitraries.js';

const COMPONENT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

const arbComponent = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...COMPONENT_CHARS), { minLength: 1, maxLength: 10 })
    .map((chars: ReadonlyArray<string>) => chars.join(''))
    .filter((s: string) => !s.startsWith('-') && !s.endsWith('.lock') && !s.startsWith('.'));

export function arbRefName(): fc.Arbitrary<RefName> {
  return fc
    .array(arbComponent(), { minLength: 2, maxLength: 4 })
    .map((components: ReadonlyArray<string>) => components.join('/') as RefName);
}

/** One packed-refs entry, optionally peeled — a rewrite must drop a peeled
 *  value together with its entry, never leave it orphaned. */
export function arbPackedRefEntry(): fc.Arbitrary<PackedRefEntry> {
  return fc
    .tuple(arbRefName(), arbObjectId(), fc.option(arbObjectId(), { nil: undefined }))
    .map(([name, id, peeled]) => (peeled === undefined ? { name, id } : { name, id, peeled }));
}

/** Arbitrary short strings over fast-check's default (ASCII) alphabet — any
 *  glob metacharacter included, as a pattern or as a ref text. */
export function arbGlobText(): fc.Arbitrary<string> {
  return fc.string({ minLength: 0, maxLength: 12 });
}

/** A glob-metacharacter-free literal — matches only itself. */
export function arbGlobLiteral(minLength = 0): fc.Arbitrary<string> {
  return fc.stringMatching(new RegExp(`^[a-z/0-9-]{${minLength},12}$`));
}

/** A single ASCII byte outside every glob metacharacter (`*?[]\`) and every
 *  bracket-set operator (`!^-`) — safe to escape or to embed as a bracket
 *  member without perturbing the grammar. */
export function arbPlainGlobChar(): fc.Arbitrary<string> {
  return fc.stringMatching(/^[a-zA-Z0-9/]$/);
}
