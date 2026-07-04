import fc from 'fast-check';

import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { SectionName } from '../../../../../src/domain/protocol/v2/sections.js';
import { oidArb } from '../arbitraries.js';

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('');

const tokenArb = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...TOKEN_CHARS), { minLength: 1, maxLength: 16 })
    .map((chars) => chars.join(''));

const AGENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./'.split('');

const agentTokenArb = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...AGENT_CHARS), { minLength: 1, maxLength: 16 })
    .map((chars) => chars.join(''));

export const commandArb = (): fc.Arbitrary<string> => tokenArb();

export const argsArb = (): fc.Arbitrary<ReadonlyArray<string>> =>
  fc.array(tokenArb(), { minLength: 0, maxLength: 5 });

export const payloadsArb = (): fc.Arbitrary<ReadonlyArray<Uint8Array>> =>
  fc.array(fc.uint8Array({ minLength: 0, maxLength: 24 }), { minLength: 0, maxLength: 5 });

export interface RefFixture {
  readonly name: string;
  readonly id: ObjectId;
  readonly peeled?: ObjectId;
}

const refNameArb = (): fc.Arbitrary<string> =>
  fc
    .tuple(fc.constantFrom('refs/heads/', 'refs/tags/'), tokenArb())
    .map(([prefix, suffix]) => `${prefix}${suffix}`);

export const refFixtureArb = (): fc.Arbitrary<RefFixture> =>
  fc
    .tuple(refNameArb(), oidArb(), fc.option(oidArb(), { nil: undefined }))
    .map(([name, id, peeled]) => (peeled === undefined ? { name, id } : { name, id, peeled }));

export const refFixturesArb = (): fc.Arbitrary<ReadonlyArray<RefFixture>> =>
  fc.uniqueArray(refFixtureArb(), { selector: (ref) => ref.name, minLength: 0, maxLength: 6 });

export type HeadFixture =
  | { readonly kind: 'none' }
  | { readonly kind: 'detached'; readonly id: ObjectId }
  | { readonly kind: 'symref'; readonly target: string; readonly wireId: ObjectId };

export const headFixtureArb = (refs: ReadonlyArray<RefFixture>): fc.Arbitrary<HeadFixture> => {
  const none = fc.constant<HeadFixture>({ kind: 'none' });
  const detached = oidArb().map((id): HeadFixture => ({ kind: 'detached', id }));
  if (refs.length === 0) return fc.oneof(none, detached);
  const symref = fc
    .tuple(fc.constantFrom(...refs.map((ref) => ref.name)), oidArb())
    .map(([target, wireId]): HeadFixture => ({ kind: 'symref', target, wireId }));
  return fc.oneof(none, detached, symref);
};

export const KNOWN_SECTION_NAMES: ReadonlyArray<SectionName> = [
  'acknowledgments',
  'shallow-info',
  'wanted-refs',
  'packfile',
];

export interface SectionFixture {
  readonly name: SectionName;
  readonly lines: ReadonlyArray<string>;
}

const sectionFixtureArb = (name: SectionName): fc.Arbitrary<SectionFixture> =>
  fc.array(tokenArb(), { minLength: 0, maxLength: 4 }).map((lines) => ({ name, lines }));

export const sectionFixturesArb = (): fc.Arbitrary<ReadonlyArray<SectionFixture>> =>
  fc
    .shuffledSubarray([...KNOWN_SECTION_NAMES], {
      minLength: 0,
      maxLength: KNOWN_SECTION_NAMES.length,
    })
    .chain((names) => fc.tuple(...names.map((name) => sectionFixtureArb(name))));

export const agentArb = (): fc.Arbitrary<string> => agentTokenArb();

export const fetchFeatureArb = (): fc.Arbitrary<string> => tokenArb();

export const fetchFeaturesArb = (): fc.Arbitrary<ReadonlyArray<string>> =>
  fc.uniqueArray(fetchFeatureArb(), { minLength: 0, maxLength: 4 });

export const V2_COMMAND_NAMES = ['ls-refs', 'fetch'] as const;
export type V2CommandName = (typeof V2_COMMAND_NAMES)[number];

export const commandSetArb = (): fc.Arbitrary<ReadonlyArray<V2CommandName>> =>
  fc.shuffledSubarray([...V2_COMMAND_NAMES], { minLength: 0, maxLength: V2_COMMAND_NAMES.length });
