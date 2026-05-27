import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetDeprecationState,
  warnDeprecated,
} from '../../../../src/application/primitives/deprecation.js';

describe('warnDeprecated', () => {
  beforeEach(() => {
    _resetDeprecationState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a fresh dedup state', () => {
    describe('When warnDeprecated is called twice with the same callsite', () => {
      it('Then console.warn fires exactly once', () => {
        // Arrange
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act
        warnDeprecated('walkTree', 'use snapshot.tree() instead');
        warnDeprecated('walkTree', 'use snapshot.tree() instead');

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    describe('When warnDeprecated is called with two distinct callsites', () => {
      it('Then console.warn fires twice', () => {
        // Arrange
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act
        warnDeprecated('walkTree', 'use snapshot.tree() instead');
        warnDeprecated('walkIndex', 'use snapshot.index() instead');

        // Assert
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given TSGIT_SUPPRESS_DEPRECATIONS=1', () => {
    describe('When warnDeprecated is called', () => {
      it('Then console.warn is never invoked (suppression honors the EXACT env var name)', () => {
        // Arrange
        const original = process.env['TSGIT_SUPPRESS_DEPRECATIONS'];
        process.env['TSGIT_SUPPRESS_DEPRECATIONS'] = '1';
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act
        warnDeprecated('walkTree', 'msg');

        // Assert
        try {
          expect(spy).not.toHaveBeenCalled();
        } finally {
          if (original === undefined) {
            delete process.env['TSGIT_SUPPRESS_DEPRECATIONS'];
          } else {
            process.env['TSGIT_SUPPRESS_DEPRECATIONS'] = original;
          }
        }
      });
    });
  });

  describe('Given the message is formatted into the console output', () => {
    describe('When warnDeprecated emits', () => {
      it('Then the line includes the [tsgit deprecation] prefix, callsite, and message', () => {
        // Arrange
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act
        warnDeprecated('walkTree', 'use snapshot.tree() instead');

        // Assert
        expect(spy).toHaveBeenCalledWith(
          '[tsgit deprecation] walkTree: use snapshot.tree() instead',
        );
      });
    });
  });
});
