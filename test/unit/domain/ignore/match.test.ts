import { describe, expect, it } from 'vitest';

import { matches, matchesVerbose } from '../../../../src/domain/ignore/match.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

const path = (s: string): FilePath => s as FilePath;

describe('matches', () => {
  describe('Given an empty ruleset', () => {
    describe('When matches anything', () => {
      it('Then returns "unset"', () => {
        // Arrange
        const rules = parseGitignore('');

        // Act
        const sut = matches(rules, path('foo.ts'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given ruleset=[*.log] and path "foo.log"', () => {
    describe('When matches', () => {
      it('Then returns "ignored"', () => {
        // Arrange
        const rules = parseGitignore('*.log');

        // Act
        const sut = matches(rules, path('foo.log'), false);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given ruleset=[*.log, !important.log] and path "important.log"', () => {
    describe('When matches', () => {
      it('Then "unignored" (last-match wins)', () => {
        // Arrange
        const rules = parseGitignore('*.log\n!important.log');

        // Act
        const sut = matches(rules, path('important.log'), false);

        // Assert
        expect(sut).toBe('unignored');
      });
    });
  });

  describe('Given ruleset=[build/] and path "build" with isDir=true', () => {
    describe('When matches', () => {
      it('Then "ignored"', () => {
        // Arrange
        const rules = parseGitignore('build/');

        // Act
        const sut = matches(rules, path('build'), true);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given ruleset=[build/] and path "build" with isDir=false', () => {
    describe('When matches', () => {
      it('Then "unset" (directory-only)', () => {
        // Arrange
        const rules = parseGitignore('build/');

        // Act
        const sut = matches(rules, path('build'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given ruleset=[/dist] and path "dist"', () => {
    describe('When matches', () => {
      it('Then "ignored" (anchored matches root)', () => {
        // Arrange
        const rules = parseGitignore('/dist');

        // Act
        const sut = matches(rules, path('dist'), true);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given ruleset=[/dist] and path "src/dist"', () => {
    describe('When matches', () => {
      it('Then "unset" (anchored does NOT match nested)', () => {
        // Arrange
        const rules = parseGitignore('/dist');

        // Act
        const sut = matches(rules, path('src/dist'), true);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given ruleset=[**/node_modules] and path "a/b/node_modules"', () => {
    describe('When matches', () => {
      it('Then "ignored"', () => {
        // Arrange
        const rules = parseGitignore('**/node_modules');

        // Act
        const sut = matches(rules, path('a/b/node_modules'), true);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given a non-matching pattern', () => {
    describe('When matches', () => {
      it('Then "unset"', () => {
        // Arrange
        const rules = parseGitignore('*.log');

        // Act
        const sut = matches(rules, path('foo.txt'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });
});

describe('matchesVerbose', () => {
  describe('Given an empty ruleset', () => {
    describe('When called', () => {
      it('Then verdict is "unset" with no ruleIndex', () => {
        // Arrange
        const rules = parseGitignore('');

        // Act
        const sut = matchesVerbose(rules, path('foo.ts'), false);

        // Assert
        expect(sut.verdict).toBe('unset');
        expect(sut.ruleIndex).toBeUndefined();
      });
    });
  });

  describe('Given a single ignoring rule', () => {
    describe('When matched', () => {
      it('Then verdict is "ignored" with ruleIndex 0', () => {
        // Arrange
        const rules = parseGitignore('*.log');

        // Act
        const sut = matchesVerbose(rules, path('foo.log'), false);

        // Assert
        expect(sut.verdict).toBe('ignored');
        expect(sut.ruleIndex).toBe(0);
      });
    });
  });

  describe('Given ruleset [*.log, !keep.log] matched against keep.log', () => {
    describe('When matched', () => {
      it('Then verdict "unignored" with ruleIndex 1 (last match wins)', () => {
        // Arrange
        const rules = parseGitignore('*.log\n!keep.log');

        // Act
        const sut = matchesVerbose(rules, path('keep.log'), false);

        // Assert
        expect(sut.verdict).toBe('unignored');
        expect(sut.ruleIndex).toBe(1);
      });
    });
  });

  describe('Given a directory-only rule and a non-directory path', () => {
    describe('When matched', () => {
      it('Then verdict is "unset"', () => {
        // Arrange — directory-only rule must be skipped for files; the ruleIndex
        // path inside the inner branch is asserted alongside the verdict so a
        // mutant that returns `ruleIndex` despite a skipped rule is killed.
        const rules = parseGitignore('build/');

        // Act
        const sut = matchesVerbose(rules, path('build'), false);

        // Assert
        expect(sut.verdict).toBe('unset');
        expect(sut.ruleIndex).toBeUndefined();
      });
    });
  });

  describe('Given a non-matching pattern', () => {
    describe('When called', () => {
      it('Then verdict "unset" with no ruleIndex', () => {
        // Arrange
        const rules = parseGitignore('*.log');

        // Act
        const sut = matchesVerbose(rules, path('foo.txt'), false);

        // Assert
        expect(sut.verdict).toBe('unset');
        expect(sut.ruleIndex).toBeUndefined();
      });
    });
  });

  describe('Given two ignoring rules that both match', () => {
    describe('When called', () => {
      it('Then verdict carries the LAST matching ruleIndex', () => {
        // Arrange — both `*.log` and `foo.log` match `foo.log`. Last-match-wins
        // semantics means we report rule index 1, not 0.
        const rules = parseGitignore('*.log\nfoo.log');

        // Act
        const sut = matchesVerbose(rules, path('foo.log'), false);

        // Assert
        expect(sut.verdict).toBe('ignored');
        expect(sut.ruleIndex).toBe(1);
      });
    });
  });
});
