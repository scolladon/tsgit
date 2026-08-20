import { describe, expect, it } from 'vitest';
import { isAllowlisted } from '../../../../src/domain/repository/allowlist.js';

describe('isAllowlisted', () => {
  describe('Given entries and a repository path', () => {
    describe('When isAllowlisted runs', () => {
      it.each([
        { label: 'an exact match', entries: ['/srv/repo'], path: '/srv/repo', verdict: true },
        {
          label: 'a trailing slash on the entry',
          entries: ['/srv/repo/'],
          path: '/srv/repo',
          verdict: true,
        },
        {
          label: 'a trailing slash on the path',
          entries: ['/srv/repo'],
          path: '/srv/repo/',
          verdict: true,
        },
        {
          label:
            'an entry naming the gitdir, not the repository path — the allowlist keys on ONE path',
          entries: ['/srv/repo/.git'],
          path: '/srv/repo',
          verdict: false,
        },
        {
          label: 'an entry naming an ancestor — no implicit descent',
          entries: ['/srv'],
          path: '/srv/repo',
          verdict: false,
        },
        {
          label: "the wildcard entry '*'",
          entries: ['*'],
          path: '/anywhere/at/all',
          verdict: true,
        },
        {
          label: 'a /* prefix matching an immediate child',
          entries: ['/srv/*'],
          path: '/srv/repo',
          verdict: true,
        },
        {
          label: 'a /* prefix matching at any depth, not just immediate children',
          entries: ['/srv/*'],
          path: '/srv/a/b/repo',
          verdict: true,
        },
        {
          label: 'a /* prefix against the prefix itself — strictly below, never the prefix',
          entries: ['/srv/repo/*'],
          path: '/srv/repo',
          verdict: false,
        },
        {
          label: 'a trailing-star entry with no slash — not an fnmatch',
          entries: ['/srv/nor*'],
          path: '/srv/normal',
          verdict: false,
        },
        {
          label: 'a double-star entry — ** is not special',
          entries: ['/srv/repo/**'],
          path: '/srv/repo/x',
          verdict: false,
        },
        {
          label: 'a sibling directory sharing a prefix — the classic prefix-boundary bug',
          entries: ['/srv/repo'],
          path: '/srv/repo-evil',
          verdict: false,
        },
        {
          label: 'differing case only — case-sensitive',
          entries: ['/SRV/REPO'],
          path: '/srv/repo',
          verdict: false,
        },
        {
          label: 'an empty entry list — the identity',
          entries: [],
          path: '/anywhere',
          verdict: false,
        },
        {
          label: 'multiple entries where any one may match',
          entries: ['/other', '/srv/repo'],
          path: '/srv/repo',
          verdict: true,
        },
        {
          label: 'the root path — must not strip to the empty string',
          entries: ['/'],
          path: '/',
          verdict: true,
        },
        {
          label:
            'a /* prefix against a sibling sharing the prefix — the boundary separator is load-bearing',
          entries: ['/srv/*'],
          path: '/srv-other/repo',
          verdict: false,
        },
        {
          label: "the root prefix '/*' — every absolute path is strictly below the root",
          entries: ['/*'],
          path: '/srv/repo',
          verdict: true,
        },
        {
          label: "the root prefix '/*' against a single-segment path",
          entries: ['/*'],
          path: '/a',
          verdict: true,
        },
        {
          label: "the root prefix '/*' must not match the root itself — strictly below",
          entries: ['/*'],
          path: '/',
          verdict: false,
        },
        {
          label: 'a doubled separator before the star',
          entries: ['/srv//*'],
          path: '/srv/repo',
          verdict: true,
        },
        {
          label:
            'the root entry against an empty path — the trailing-slash strip stops at length 1',
          entries: ['/'],
          path: '',
          verdict: false,
        },
      ])('Then it returns $verdict for $label', ({ entries, path, verdict }) => {
        // Arrange
        const sut = isAllowlisted;

        // Act
        const result = sut(path, entries);

        // Assert
        expect(result).toBe(verdict);
      });
    });
  });
});
