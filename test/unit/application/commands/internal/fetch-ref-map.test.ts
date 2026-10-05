import { describe, expect, it } from 'vitest';
import { mapFetchedRefs } from '../../../../../src/application/commands/internal/fetch-ref-map.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { AdvertisedRef } from '../../../../../src/domain/protocol/index.js';

const OID = 'a'.repeat(40) as ObjectId;
const advertised = (...names: string[]): ReadonlyArray<AdvertisedRef> =>
  names.map((name) => ({ name, id: OID }));
const ORIGIN_HEADS = '+refs/heads/*:refs/remotes/origin/*';

describe('mapFetchedRefs', () => {
  describe.each([
    {
      label: 'an exact refspec naming an advertised ref',
      specs: ['refs/heads/main:refs/remotes/solo/trunk'],
      refs: advertised('refs/heads/main', 'refs/heads/other'),
      expected: [['refs/heads/main', 'refs/remotes/solo/trunk']],
    },
    {
      label: 'an exact refspec naming no advertised ref',
      specs: ['refs/heads/gone:refs/remotes/solo/gone'],
      refs: advertised('refs/heads/main'),
      expected: [],
    },
    {
      label: 'an exact refspec with an empty destination, which stores into no ref',
      specs: ['refs/heads/main:'],
      refs: advertised('refs/heads/main', 'refs/tags/v1'),
      expected: [],
    },
    {
      label: 'a pattern refspec over a peeled tag line',
      specs: ['+refs/tags/*:refs/tags/*'],
      refs: advertised('refs/tags/v1', 'refs/tags/v1^{}'),
      expected: [['refs/tags/v1', 'refs/tags/v1']],
    },
    {
      label: 'a branch refspec beside advertised tags, which follow it',
      specs: [ORIGIN_HEADS],
      refs: advertised('refs/heads/main', 'refs/tags/v1', 'refs/tags/v1^{}'),
      expected: [
        ['refs/heads/main', 'refs/remotes/origin/main'],
        ['refs/tags/v1', 'refs/tags/v1'],
      ],
    },
    {
      label: 'two refspecs storing one remote ref into one local ref',
      specs: [ORIGIN_HEADS, '+refs/heads/main:refs/remotes/origin/main'],
      refs: advertised('refs/heads/main'),
      expected: [['refs/heads/main', 'refs/remotes/origin/main']],
    },
    {
      label: 'a negative refspec naming an advertised branch',
      specs: [ORIGIN_HEADS, '^refs/heads/secret'],
      refs: advertised('refs/heads/main', 'refs/heads/secret'),
      expected: [['refs/heads/main', 'refs/remotes/origin/main']],
    },
  ])('Given $label', ({ specs, refs, expected }) => {
    describe('When the advertised refs are mapped', () => {
      it('Then each source pairs with the local ref it updates', () => {
        // Arrange
        const sut = mapFetchedRefs;

        // Act
        const result = sut(specs, refs);

        // Assert
        expect(result.map((entry) => [entry.source.name, entry.target])).toEqual(expected);
      });
    });
  });
});
