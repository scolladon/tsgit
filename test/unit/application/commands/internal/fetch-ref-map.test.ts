import { describe, expect, it } from 'vitest';
import {
  getRefMap,
  type LocalState,
  type RefMapRequest,
} from '../../../../../src/application/commands/internal/fetch-ref-map.js';
import type { TsgitError } from '../../../../../src/domain/index.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import type { AdvertisedRef } from '../../../../../src/domain/protocol/index.js';

const OID = 'a'.repeat(40) as ObjectId;
const OTHER = 'b'.repeat(40) as ObjectId;
const THIRD = 'c'.repeat(40) as ObjectId;
const advertised = (...names: string[]): ReadonlyArray<AdvertisedRef> =>
  names.map((name) => ({ name, id: OID }));
const ORIGIN_HEADS = '+refs/heads/*:refs/remotes/origin/*';
const configured = (...configSpecs: string[]): RefMapRequest => ({
  hashConfig: SHA1_CONFIG,
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
    {
      label: 'a command-line negative refspec naming no advertised ref',
      request: fromCli(['refs/heads/main:refs/remotes/o/main', '^refs/heads/absent'], ['']),
      refs: advertised('refs/heads/main'),
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
      label: 'a configured exact refspec naming no advertised ref',
      request: configured('refs/heads/gone:refs/remotes/solo/gone', ORIGIN_HEADS),
      expected: { code: 'REMOTE_REF_NOT_FOUND', ref: 'refs/heads/gone' },
    },
    {
      label: 'two configured refspecs storing two remote refs into one local ref',
      request: configured('refs/heads/main:refs/remotes/o/x', 'refs/heads/b:refs/remotes/o/x'),
      expected: {
        code: 'FETCH_REFSPEC_CONFLICT',
        reason: 'cannot-fetch-both',
        target: 'refs/remotes/o/x',
        sources: ['refs/heads/main', 'refs/heads/b'],
      },
    },
    {
      label: 'two tracking refspecs storing two command-line refs into one local ref',
      request: {
        ...fromCli(['main', 'b']),
        configSpecs: ['refs/heads/main:refs/remotes/o/x', 'refs/heads/b:refs/remotes/o/x'],
      },
      expected: {
        code: 'FETCH_REFSPEC_CONFLICT',
        reason: 'tracks-both',
        target: 'refs/remotes/o/x',
        sources: ['refs/heads/main', 'refs/heads/b'],
      },
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
        const result = sut(request, advertised('refs/heads/main', 'refs/heads/b'));

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    {
      label: 'a tag on a fetched commit',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/v1', id: OID },
      ],
      local: { refs: new Set<string>(), objects: new Set<ObjectId>(), symrefs: new Set<string>() },
      expected: ['refs/tags/v1'],
    },
    {
      label: 'a tag outside the fetched history and absent locally',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/far', id: OTHER },
      ],
      local: { refs: new Set<string>(), objects: new Set<ObjectId>(), symrefs: new Set<string>() },
      expected: [],
    },
    {
      label: 'a tag on an object present locally',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/far', id: OTHER },
      ],
      local: {
        refs: new Set<string>(),
        objects: new Set<ObjectId>([OTHER]),
        symrefs: new Set<string>(),
      },
      expected: ['refs/tags/far'],
    },
    {
      label: 'a tag the repository already has',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/v1', id: OID },
      ],
      local: {
        refs: new Set<string>(['refs/tags/v1']),
        objects: new Set<ObjectId>(),
        symrefs: new Set<string>(),
      },
      expected: [],
    },
    {
      label: 'an annotated tag peeling to a fetched commit',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/va', id: OTHER, peeled: OID },
      ],
      local: { refs: new Set<string>(), objects: new Set<ObjectId>(), symrefs: new Set<string>() },
      expected: ['refs/tags/va'],
    },
    {
      label: 'an annotated tag peeling to a locally present commit',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/va', id: OTHER, peeled: THIRD },
      ],
      local: {
        refs: new Set<string>(),
        objects: new Set<ObjectId>([THIRD]),
        symrefs: new Set<string>(),
      },
      expected: ['refs/tags/va'],
    },
    {
      label: 'an annotated tag peeling outside the fetched history',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/va', id: OTHER, peeled: THIRD },
      ],
      local: { refs: new Set<string>(), objects: new Set<ObjectId>(), symrefs: new Set<string>() },
      expected: [],
    },
    {
      label: 'tags advertised out of name order',
      refs: [
        { name: 'refs/heads/main', id: OID },
        { name: 'refs/tags/b', id: OID },
        { name: 'refs/tags/c', id: OID },
        { name: 'refs/tags/a', id: OID },
      ],
      local: { refs: new Set<string>(), objects: new Set<ObjectId>(), symrefs: new Set<string>() },
      expected: ['refs/tags/a', 'refs/tags/b', 'refs/tags/c'],
    },
  ] as ReadonlyArray<{
    label: string;
    refs: ReadonlyArray<AdvertisedRef>;
    local: LocalState;
    expected: ReadonlyArray<string>;
  }>)('Given $label', ({ refs, local, expected }) => {
    describe('When the ref map follows tags', () => {
      it('Then only tags pointing into what the repository will have follow, by name', () => {
        // Arrange
        const sut = getRefMap;

        // Act
        const result = sut(configured(ORIGIN_HEADS), refs, local);

        // Assert
        expect(
          result
            .filter((entry) => entry.source.name.startsWith('refs/tags/'))
            .map((entry) => entry.target),
        ).toEqual(expected);
      });
    });
  });

  describe('Given a command-line refspec storing into the ref a tracking refspec maps another ref to', () => {
    describe('When the ref map is built', () => {
      it('Then the command-line ref wins and git warns of the usual tracking', () => {
        // Arrange
        const sut = getRefMap;
        const warnings: string[] = [];

        // Act
        const result = sut(
          fromCli(['refs/heads/a:refs/remotes/origin/b', 'b']),
          advertised('refs/heads/a', 'refs/heads/b'),
          undefined,
          (message) => warnings.push(message),
        );

        // Assert
        expect(result.map((entry) => [entry.source.name, entry.target])).toEqual([
          ['refs/heads/a', 'refs/remotes/origin/b'],
          ['refs/heads/b', undefined],
          ['refs/heads/a', 'refs/remotes/origin/a'],
        ]);
        expect(warnings).toEqual([
          'refs/remotes/origin/b usually tracks refs/heads/b, not refs/heads/a',
        ]);
      });
    });
  });

  describe.each([
    {
      label: 'a command-line refspec naming an object id',
      request: fromCli([THIRD]),
      expected: [[THIRD, THIRD, undefined, 'merge']],
    },
    {
      label: 'a command-line refspec storing an object id into a branch',
      request: fromCli([`${THIRD}:refs/heads/x`]),
      expected: [[THIRD, THIRD, 'refs/heads/x', 'merge']],
    },
    {
      label: 'a command-line refspec naming an object id in upper case',
      request: fromCli([THIRD.toUpperCase()]),
      expected: [[THIRD.toUpperCase(), THIRD, undefined, 'merge']],
    },
    {
      label: 'a configured refspec naming an object id',
      request: configured(`${THIRD}:refs/remotes/origin/pinned`),
      expected: [[THIRD, THIRD, 'refs/remotes/origin/pinned', 'merge']],
    },
  ])('Given $label', ({ request, expected }) => {
    describe('When the ref map is built', () => {
      it('Then the object id is fetched as the source itself, advertised or not', () => {
        // Arrange
        const sut = getRefMap;

        // Act
        const result = sut(request, advertised('refs/heads/main'));

        // Assert
        expect(
          result.map((entry) => [entry.source.name, entry.source.id, entry.target, entry.status]),
        ).toEqual(expected);
      });
    });
  });

  describe('Given a sha256 repository and a command-line refspec of forty hex digits', () => {
    describe('When the ref map is built', () => {
      it('Then the digits are no object id and name a remote ref that does not exist', () => {
        // Arrange
        const sut = refusal;

        // Act
        const result = sut(
          { ...fromCli([THIRD]), hashConfig: SHA256_CONFIG },
          advertised('refs/heads/main'),
        );

        // Assert
        expect(result).toEqual({ code: 'REMOTE_REF_NOT_FOUND', ref: THIRD });
      });
    });
  });

  describe.each([
    {
      label: 'a pattern refspec mapping a remote ref onto a local symref',
      request: configured(ORIGIN_HEADS),
      expected: [['refs/heads/main', 'refs/remotes/origin/main']],
    },
    {
      label: 'a command-line pattern whose tracking refspec maps onto a local symref',
      request: fromCli(['refs/heads/*:refs/remotes/mirror/*']),
      expected: [
        ['refs/heads/foo', 'refs/remotes/mirror/foo'],
        ['refs/heads/main', 'refs/remotes/mirror/main'],
        ['refs/heads/main', 'refs/remotes/origin/main'],
      ],
    },
    {
      label: 'an exact refspec storing into a local symref',
      request: configured('refs/heads/foo:refs/remotes/origin/foo'),
      expected: [['refs/heads/foo', 'refs/remotes/origin/foo']],
    },
  ])('Given $label', ({ request, expected }) => {
    describe('When the ref map is built', () => {
      it('Then only a pattern skips the local ref that is a symref', () => {
        // Arrange
        const sut = getRefMap;
        const local: LocalState = {
          refs: new Set<string>(['refs/remotes/origin/foo']),
          objects: new Set<ObjectId>(),
          symrefs: new Set<string>(['refs/remotes/origin/foo']),
        };

        // Act
        const result = sut(request, advertised('refs/heads/foo', 'refs/heads/main'), local);

        // Assert
        expect(result.map((entry) => [entry.source.name, entry.target])).toEqual(expected);
      });
    });
  });

  describe.each([
    {
      label: 'a forcing pattern refspec',
      request: configured(ORIGIN_HEADS),
      refs: advertised('refs/heads/main'),
      expected: [['refs/remotes/origin/main', true]],
    },
    {
      label: 'a pattern refspec without the force flag',
      request: configured('refs/heads/*:refs/remotes/origin/*'),
      refs: advertised('refs/heads/main'),
      expected: [['refs/remotes/origin/main', false]],
    },
    {
      label: 'a forcing exact refspec',
      request: configured('+refs/heads/main:refs/remotes/solo/main'),
      refs: advertised('refs/heads/main'),
      expected: [['refs/remotes/solo/main', true]],
    },
    {
      label: 'an exact refspec without the force flag',
      request: configured('refs/heads/main:refs/remotes/solo/main'),
      refs: advertised('refs/heads/main'),
      expected: [['refs/remotes/solo/main', false]],
    },
    {
      label: 'a forcing command-line refspec storing into no ref',
      request: fromCli(['+refs/heads/main']),
      refs: advertised('refs/heads/main'),
      expected: [
        [undefined, false],
        ['refs/remotes/origin/main', true],
      ],
    },
    {
      label: 'a branch refspec a tag follows',
      request: configured(ORIGIN_HEADS),
      refs: advertised('refs/heads/main', 'refs/tags/v1'),
      expected: [
        ['refs/remotes/origin/main', true],
        ['refs/tags/v1', false],
      ],
    },
    {
      label: 'a merge source no refspec maps',
      request: {
        ...configured('refs/heads/main:refs/remotes/origin/main'),
        merge: ['refs/heads/other'],
        mergesFromRemote: true,
      },
      refs: advertised('refs/heads/main', 'refs/heads/other'),
      expected: [
        ['refs/remotes/origin/main', false],
        [undefined, false],
      ],
    },
  ] as ReadonlyArray<{
    label: string;
    request: RefMapRequest;
    refs: ReadonlyArray<AdvertisedRef>;
    expected: ReadonlyArray<readonly [string | undefined, boolean]>;
  }>)('Given $label', ({ request, refs, expected }) => {
    describe('When the ref map is built', () => {
      it('Then each local ref carries the force flag of the refspec that maps it', () => {
        // Arrange
        const sut = getRefMap;

        // Act
        const result = sut(request, refs);

        // Assert
        expect(result.map((entry) => [entry.target, entry.force])).toEqual(expected);
      });
    });
  });
});
