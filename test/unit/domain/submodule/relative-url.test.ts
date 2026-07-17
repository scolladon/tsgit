import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import { relativeUrl, resolveSubmoduleUrl } from '../../../../src/domain/submodule/relative-url.js';

describe('Given a relative submodule URL and a base remote URL', () => {
  describe('When resolving an https base', () => {
    it('Then `../` pops the last path component', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git', '../sub')).toBe('https://h.x/a/b/sub');
    });

    it('Then `../../` pops two components', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git', '../../sub')).toBe('https://h.x/a/sub');
    });

    it('Then `./` keeps every component', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git', './sub')).toBe(
        'https://h.x/a/b/super.git/sub',
      );
    });

    it('Then a trailing slash on the relative url is stripped', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git', '../sub/')).toBe('https://h.x/a/b/sub');
    });

    it('Then over-popping past the host collapses without error', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/super.git', '../../../../sub')).toBe('https:/sub');
    });

    it('Then a bare `../` leaves a trailing slash', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git', '../')).toBe('https://h.x/a/b/');
    });

    it('Then one trailing slash on the base is stripped before popping', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git/', '../sub')).toBe('https://h.x/a/b/sub');
    });

    it('Then a colon in the popped url tail keeps it a local path', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/a/b/super.git', '../a:b')).toBe('https://h.x/a/b/a:b');
    });

    it('Then over-popping past the scheme colon joins the dot base with a colon', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/super.git', '../../../../../sub')).toBe('.:sub');
    });

    it('Then over-popping until the base is a bare dot refuses', () => {
      // Arrange
      const sut = relativeUrl;
      // Act
      let thrown: unknown;
      try {
        sut('https://h.x/super.git', '../../../../../../sub');
      } catch (err) {
        thrown = err;
      }
      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      expect((thrown as TsgitError).data).toMatchObject({
        code: 'RELATIVE_URL_UNRESOLVABLE',
        url: '.',
      });
    });
  });

  describe('When resolving an scp-style base', () => {
    it('Then a path component is popped, separator preserved', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('git@h.x:a/b/super.git', '../sub')).toBe('git@h.x:a/b/sub');
    });

    it('Then popping the single component restores the colon separator', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('git@h.x:super.git', '../sub')).toBe('git@h.x:sub');
    });

    it('Then popping a base whose only colon leads restores that colon', () => {
      // Arrange + Act + Assert
      expect(relativeUrl(':foo', '../x')).toBe(':x');
    });
  });

  describe('When resolving an absolute-path base', () => {
    it('Then `../` pops the last path segment', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('/abs/path/super', '../sub')).toBe('/abs/path/sub');
    });

    it('Then over-popping past the filesystem root collapses to a bare url', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('/a', '../../sub')).toBe('sub');
    });
  });

  describe('When the submodule url is not relative', () => {
    it('Then an absolute https url is returned verbatim', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/super', 'https://other/x.git')).toBe('https://other/x.git');
    });

    it('Then an scp url is returned verbatim', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/super', 'git@other:x.git')).toBe('git@other:x.git');
    });

    it('Then a url whose only colon leads is returned verbatim', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/super', ':foo')).toBe(':foo');
    });

    it('Then an absolute-path url is returned verbatim', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('https://h.x/super', '/abs/sub')).toBe('/abs/sub');
    });
  });

  describe('When the base is itself a relative path', () => {
    it('Then it is normalised with a leading `./` before popping', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('a/b/super', '../sub')).toBe('a/b/sub');
    });

    it('Then a base already prefixed with `./` is not double-prefixed', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('./a/b/super', '../sub')).toBe('a/b/sub');
    });

    it('Then a base already prefixed with `./` resolves a `./` url', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('./a/b/super', './sub')).toBe('a/b/super/sub');
    });

    it('Then over-popping a relative base past its root refuses', () => {
      // Arrange
      const sut = relativeUrl;
      // Act
      let thrown: unknown;
      try {
        sut('.', '../../x');
      } catch (err) {
        thrown = err;
      }
      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      expect((thrown as TsgitError).data).toMatchObject({ code: 'RELATIVE_URL_UNRESOLVABLE' });
    });

    it('Then a single-component base is normalised so `../` pops to the bare url', () => {
      // Arrange + Act + Assert
      expect(relativeUrl('a', '../sub')).toBe('sub');
    });

    it('Then a base starting with `../` over-popped past its root refuses', () => {
      // Arrange
      const sut = relativeUrl;
      // Act
      let thrown: unknown;
      try {
        sut('../a', '../../sub');
      } catch (err) {
        thrown = err;
      }
      // Assert
      expect(thrown).toBeInstanceOf(TsgitError);
      expect((thrown as TsgitError).data).toMatchObject({
        code: 'RELATIVE_URL_UNRESOLVABLE',
        url: '..',
      });
    });
  });
});

describe('Given a .gitmodules submodule url and a base', () => {
  describe('When the url is dot-relative', () => {
    it('Then a `../` url resolves against the base', () => {
      // Arrange + Act + Assert
      expect(resolveSubmoduleUrl('https://h.x/a/b/super.git', '../sub')).toBe(
        'https://h.x/a/b/sub',
      );
    });

    it('Then a `./` url resolves against the base', () => {
      // Arrange + Act + Assert
      expect(resolveSubmoduleUrl('https://h.x/a/super.git', './sub')).toBe(
        'https://h.x/a/super.git/sub',
      );
    });
  });

  describe('When the url is not dot-relative', () => {
    it('Then a bare relative url is used verbatim', () => {
      // Arrange + Act + Assert
      expect(resolveSubmoduleUrl('https://h.x/a/b/super.git', 'sub')).toBe('sub');
    });

    it('Then an absolute https url is used verbatim', () => {
      // Arrange + Act + Assert
      expect(resolveSubmoduleUrl('https://h.x/super', 'https://other/x.git')).toBe(
        'https://other/x.git',
      );
    });
  });
});
