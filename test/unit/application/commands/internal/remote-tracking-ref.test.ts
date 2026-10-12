import { describe, expect, it } from 'vitest';
import {
  findTrackedSources,
  findTrackingRef,
} from '../../../../../src/application/commands/internal/remote-tracking-ref.js';

const MIRROR_HEADS = '+refs/heads/*:refs/remotes/mirror/*';

describe('findTrackingRef', () => {
  describe.each([
    {
      label: 'a pattern refspec mapping the source',
      specs: [MIRROR_HEADS],
      ref: 'refs/heads/main',
      expected: 'refs/remotes/mirror/main',
    },
    {
      label: 'an exact refspec naming the source',
      specs: ['refs/heads/main:refs/remotes/solo/trunk'],
      ref: 'refs/heads/main',
      expected: 'refs/remotes/solo/trunk',
    },
    {
      label: 'an exact refspec naming another source',
      specs: ['refs/heads/main:refs/remotes/solo/trunk'],
      ref: 'refs/heads/other',
      expected: undefined,
    },
    {
      label: 'a pattern refspec whose prefix and suffix would overlap the source',
      specs: ['refs/heads/a*a:refs/remotes/o/*'],
      ref: 'refs/heads/a',
      expected: undefined,
    },
    {
      label: 'two refspecs mapping the source, the earliest winning',
      specs: ['refs/heads/b*:refs/remotes/first/*', MIRROR_HEADS],
      ref: 'refs/heads/b2',
      expected: 'refs/remotes/first/2',
    },
    {
      label: 'a refspec carrying no destination ahead of a mapping one',
      specs: ['refs/heads/main', MIRROR_HEADS],
      ref: 'refs/heads/main',
      expected: 'refs/remotes/mirror/main',
    },
    {
      label: 'a negative refspec naming the source, which a source query never reaches',
      specs: [MIRROR_HEADS, '^refs/heads/secret'],
      ref: 'refs/heads/secret',
      expected: 'refs/remotes/mirror/secret',
    },
    {
      label: 'a negative refspec naming the source an exact refspec maps',
      specs: ['refs/heads/secret:refs/remotes/solo/secret', '^refs/heads/secret'],
      ref: 'refs/heads/secret',
      expected: undefined,
    },
    {
      label: 'no fetch refspec at all',
      specs: [],
      ref: 'refs/heads/main',
      expected: undefined,
    },
  ])('Given $label', ({ specs, ref, expected }) => {
    describe('When the tracking ref is looked up', () => {
      it('Then it is the mapped destination', () => {
        // Arrange
        const sut = findTrackingRef;

        // Act
        const result = sut(specs, ref);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('findTrackedSources', () => {
  describe.each([
    {
      label: 'a pattern refspec storing into the local ref',
      specs: [MIRROR_HEADS],
      ref: 'refs/remotes/mirror/b2',
      expected: ['refs/heads/b2'],
    },
    {
      label: 'an exact refspec storing into the local ref, beside one storing elsewhere',
      specs: ['refs/heads/main:refs/remotes/solo/trunk', 'refs/heads/x:refs/remotes/solo/x'],
      ref: 'refs/remotes/solo/trunk',
      expected: ['refs/heads/main'],
    },
    {
      label: 'two refspecs storing into the local ref',
      specs: [MIRROR_HEADS, 'refs/heads/other:refs/remotes/mirror/main'],
      ref: 'refs/remotes/mirror/main',
      expected: ['refs/heads/main', 'refs/heads/other'],
    },
    {
      label: 'a negative refspec ruling the mapped source out',
      specs: [MIRROR_HEADS, '^refs/heads/secret'],
      ref: 'refs/remotes/mirror/secret',
      expected: [],
    },
    {
      label: 'a refspec storing elsewhere',
      specs: [MIRROR_HEADS],
      ref: 'refs/remotes/origin/main',
      expected: [],
    },
  ])('Given $label', ({ specs, ref, expected }) => {
    describe('When the tracked sources are looked up', () => {
      it('Then they are the remote refs mapped onto it', () => {
        // Arrange
        const sut = findTrackedSources;

        // Act
        const result = sut(specs, ref);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
