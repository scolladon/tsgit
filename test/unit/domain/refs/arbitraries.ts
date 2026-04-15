import fc from 'fast-check';
import type { RefName } from '../../../../src/domain/objects/index.js';

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
