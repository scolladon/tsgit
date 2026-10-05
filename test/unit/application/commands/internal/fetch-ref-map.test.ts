import { describe, expect, it } from 'vitest';
import {
  getRefMap,
  type RefMapRequest,
} from '../../../../../src/application/commands/internal/fetch-ref-map.js';
import type { TsgitError } from '../../../../../src/domain/index.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { AdvertisedRef } from '../../../../../src/domain/protocol/index.js';

const OID = 'a'.repeat(40) as ObjectId;
const advertised = (...names: string[]): ReadonlyArray<AdvertisedRef> =>
  names.map((name) => ({ name, id: OID }));
const ORIGIN_HEADS = '+refs/heads/*:refs/remotes/origin/*';
const configured = (...configSpecs: string[]): RefMapRequest => ({
  cliSpecs: [],
  refmap: [],
  configSpecs,
  merge: [],
  mergesFromRemote: false,
});
const fromCli = (cliSpecs: string[], refmap: string[] = []): RefMapRequest => ({
  ...configured(ORIGIN_HEADS),
  cliSpecs,
  refmap,
});
const triples = (request: RefMapRequest, refs: ReadonlyArray<AdvertisedRef>) =>
  getRefMap(request, refs).map((entry) => [entry.source.name, entry.target, entry.status]);
const refusal = (request: RefMapRequest, refs: ReadonlyArray<AdvertisedRef>): unknown => {
  try {
    getRefMap(request, refs);
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('getRefMap', () => {
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
      expected: [['refs/heads/main', undefined]],
    },
    {
      label: 'a colon-free pattern refspec, which maps nothing',
      specs: ['refs/heads/*'],
      refs: advertised('refs/heads/main'),
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
        const sut = getRefMap;

        // Act
        const result = sut(configured(...specs), refs);

        // Assert
        expect(result.map((entry) => [entry.source.name, entry.target])).toEqual(expected);
      });
    });
  });

  describe.each([
    {
      label: 'configured pattern refspecs and no merge configuration',
      request: configured(ORIGIN_HEADS),
      refs: advertised('refs/heads/b2', 'refs/heads/main', 'refs/tags/v1'),
      expected: [
        ['refs/heads/b2', 'refs/remotes/origin/b2', 'not-for-merge'],
        ['refs/heads/main', 'refs/remotes/origin/main', 'not-for-merge'],
        ['refs/tags/v1', 'refs/tags/v1', 'not-for-merge'],
      ],
    },
    {
      label: 'a merge configuration from the fetched remote',
      request: { ...configured(ORIGIN_HEADS), merge: ['refs/heads/b2'], mergesFromRemote: true },
      refs: advertised('refs/heads/b2', 'refs/heads/main'),
      expected: [
        ['refs/heads/b2', 'refs/remotes/origin/b2', 'merge'],
        ['refs/heads/main', 'refs/remotes/origin/main', 'not-for-merge'],
      ],
    },
    {
      label: 'a merge configuration from another remote',
      request: { ...configured(ORIGIN_HEADS), merge: ['refs/heads/b2'], mergesFromRemote: false },
      refs: advertised('refs/heads/b2'),
      expected: [['refs/heads/b2', 'refs/remotes/origin/b2', 'not-for-merge']],
    },
    {
      label: 'a merge configuration from another remote beside an exact first refspec',
      request: {
        ...configured('refs/heads/b2:refs/remotes/origin/b2'),
        merge: ['refs/heads/b2'],
        mergesFromRemote: false,
      },
      refs: advertised('refs/heads/b2'),
      expected: [['refs/heads/b2', 'refs/remotes/origin/b2', 'not-for-merge']],
    },
    {
      label: 'a merge configuration naming a ref the refspecs do not map',
      request: {
        ...configured('refs/heads/b2:refs/remotes/origin/b2'),
        merge: ['refs/heads/main'],
        mergesFromRemote: true,
      },
      refs: advertised('refs/heads/b2', 'refs/heads/main'),
      expected: [
        ['refs/heads/b2', 'refs/remotes/origin/b2', 'not-for-merge'],
        ['refs/heads/main', undefined, 'merge'],
      ],
    },
    {
      label: 'a merge configuration naming no advertised ref',
      request: { ...configured(ORIGIN_HEADS), merge: ['refs/heads/nope'], mergesFromRemote: true },
      refs: advertised('refs/heads/b2'),
      expected: [['refs/heads/b2', 'refs/remotes/origin/b2', 'not-for-merge']],
    },
    {
      label: 'a merge configuration and no configured refspec',
      request: { ...configured(), merge: ['main'], mergesFromRemote: true },
      refs: advertised('HEAD', 'refs/heads/main'),
      expected: [['refs/heads/main', undefined, 'merge']],
    },
    {
      label: 'an exact first refspec and no merge configuration',
      request: configured('refs/heads/b2:refs/remotes/origin/b2', ORIGIN_HEADS),
      refs: advertised('refs/heads/b2', 'refs/heads/main'),
      expected: [
        ['refs/heads/b2', 'refs/remotes/origin/b2', 'merge'],
        ['refs/heads/main', 'refs/remotes/origin/main', 'not-for-merge'],
      ],
    },
    {
      label: 'an exact second refspec and no merge configuration',
      request: configured(ORIGIN_HEADS, 'refs/heads/b2:refs/remotes/x/b2'),
      refs: advertised('refs/heads/b2'),
      expected: [
        ['refs/heads/b2', 'refs/remotes/origin/b2', 'not-for-merge'],
        ['refs/heads/b2', 'refs/remotes/x/b2', 'not-for-merge'],
      ],
    },
    {
      label: 'no configured refspec',
      request: configured(),
      refs: advertised('HEAD', 'refs/heads/main', 'refs/tags/v1'),
      expected: [['HEAD', undefined, 'merge']],
    },
    {
      label: 'command-line refspecs with no destination',
      request: fromCli(['main', 'b2']),
      refs: advertised('refs/heads/b2', 'refs/heads/main', 'refs/tags/v1'),
      expected: [
        ['refs/heads/main', undefined, 'merge'],
        ['refs/heads/b2', undefined, 'merge'],
        ['refs/heads/main', 'refs/remotes/origin/main', 'ignore'],
        ['refs/heads/b2', 'refs/remotes/origin/b2', 'ignore'],
      ],
    },
    {
      label: 'a command-line refspec with an empty refmap',
      request: fromCli(['main'], ['']),
      refs: advertised('refs/heads/main'),
      expected: [['refs/heads/main', undefined, 'merge']],
    },
    {
      label: 'a command-line refspec with a refmap',
      request: fromCli(['main'], ['refs/heads/*:refs/remotes/rm/*']),
      refs: advertised('refs/heads/main'),
      expected: [
        ['refs/heads/main', undefined, 'merge'],
        ['refs/heads/main', 'refs/remotes/rm/main', 'ignore'],
      ],
    },
    {
      label: 'a command-line refspec storing into a ref',
      request: fromCli(['main:x']),
      refs: advertised('refs/heads/main', 'refs/tags/v1'),
      expected: [
        ['refs/heads/main', 'refs/heads/x', 'merge'],
        ['refs/tags/v1', 'refs/tags/v1', 'not-for-merge'],
        ['refs/heads/main', 'refs/remotes/origin/main', 'ignore'],
      ],
    },
    {
      label: 'command-line refspecs storing under heads/, tags/ and remotes/',
      request: fromCli(['a:heads/a', 'b:tags/b', 'c:remotes/o/c', 'd:refs/d'], ['']),
      refs: advertised('refs/heads/a', 'refs/heads/b', 'refs/heads/c', 'refs/heads/d'),
      expected: [
        ['refs/heads/a', 'refs/heads/a', 'merge'],
        ['refs/heads/b', 'refs/tags/b', 'merge'],
        ['refs/heads/c', 'refs/remotes/o/c', 'merge'],
        ['refs/heads/d', 'refs/d', 'merge'],
      ],
    },
    {
      label: 'a command-line name both a tag and a branch carry',
      request: fromCli(['v1'], ['']),
      refs: advertised('refs/heads/v1', 'refs/tags/v1'),
      expected: [['refs/tags/v1', undefined, 'merge']],
    },
    {
      label: 'a command-line negative refspec',
      request: fromCli(['refs/heads/*:refs/remotes/o/*', '^refs/heads/secret'], ['']),
      refs: advertised('refs/heads/main', 'refs/heads/secret'),
      expected: [['refs/heads/main', 'refs/remotes/o/main', 'merge']],
    },
  ])('Given $label', ({ request, refs, expected }) => {
    describe('When the ref map is built', () => {
      it('Then each entry carries its local ref and FETCH_HEAD status', () => {
        // Arrange
        const sut = triples;

        // Act
        const result = sut(request, refs);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    {
      label: 'a command-line refspec naming no advertised ref',
      request: fromCli(['nope']),
      expected: { code: 'REMOTE_REF_NOT_FOUND', ref: 'nope' },
    },
    {
      label: 'an empty command-line source and no advertised HEAD',
      request: fromCli([':x']),
      expected: { code: 'REMOTE_REF_NOT_FOUND', ref: 'HEAD' },
    },
    {
      label: 'no configured refspec and no advertised HEAD',
      request: configured(),
      expected: { code: 'REMOTE_REF_NOT_FOUND', ref: 'HEAD' },
    },
    {
      label: 'a refmap and no command-line refspec',
      request: { ...configured(ORIGIN_HEADS), refmap: [''] },
      expected: {
        code: 'INVALID_OPTION',
        option: 'refmap',
        reason: '--refmap option is only meaningful with command-line refspec(s)',
      },
    },
  ])('Given $label', ({ request, expected }) => {
    describe('When the ref map is built', () => {
      it('Then it refuses as git does', () => {
        // Arrange
        const sut = refusal;

        // Act
        const result = sut(request, advertised('refs/heads/main'));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
