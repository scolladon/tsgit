import { describe, expect, it } from 'vitest';
import { parseProvesHeader } from '../../../test-pyramid/parse-proves-header.js';
import { makeManifest } from './manifest-fixture.js';

const sutConfig = () => makeManifest().heuristics.integrationProof;

describe('parseProvesHeader', () => {
  describe('happy path', () => {
    it('Given a JSDoc with all three @proves keys, When parsed, Then returns ok=true and the header values', () => {
      // Arrange
      const source = `/**
 * Some prose.
 *
 * @proves
 *   surface: clone
 *   bucket:  real-http
 *   unique:  smart-HTTP packfile exchange against canonical git-http-backend
 */
import 'x';
`;

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(true);
      if (sut.ok) {
        expect(sut.header.surface).toBe('clone');
        expect(sut.header.bucket).toBe('real-http');
        expect(sut.header.unique).toBe(
          'smart-HTTP packfile exchange against canonical git-http-backend',
        );
      }
    });

    it('Given a shebang preceding the JSDoc, When parsed, Then the parser skips the shebang and succeeds', () => {
      // Arrange
      const source = `#!/usr/bin/env node
/**
 * @proves
 *   surface: clone
 *   bucket: real-http
 *   unique: smart-HTTP packfile exchange
 */
`;

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(true);
    });

    it('Given CRLF line endings, When parsed, Then they are normalised and parsing succeeds', () => {
      // Arrange
      const body =
        '/**\r\n * @proves\r\n *   surface: clone\r\n *   bucket: real-http\r\n *   unique: smart-HTTP packfile exchange\r\n */\r\n';

      // Act
      const sut = parseProvesHeader(body, sutConfig());

      // Assert
      expect(sut.ok).toBe(true);
      if (sut.ok) expect(sut.header.surface).toBe('clone');
    });

    it('Given prose around the @proves directive, When parsed, Then extraction succeeds', () => {
      // Arrange
      const source = `/**
 * Some long-form description.
 * Multiple paragraphs.
 *
 * @proves
 *   surface: clone
 *   bucket: real-http
 *   unique: smart-HTTP packfile exchange
 *
 * Trailing prose after.
 */
`;

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(true);
    });

    it('Given extra non-required keys in the block, When parsed, Then those keys are silently ignored', () => {
      // Arrange
      const source =
        '/**\n * @proves\n *   surface: clone\n *   bucket: real-http\n *   unique: smart-HTTP packfile exchange\n *   extra: ignored\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(true);
    });

    it('Given a duplicate surface key, When parsed, Then the first occurrence wins and later ones are ignored', () => {
      // Arrange
      const source =
        '/**\n * @proves\n *   surface: clone\n *   surface: ignored\n *   bucket: real-http\n *   unique: smart-HTTP packfile exchange\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(true);
      if (sut.ok) expect(sut.header.surface).toBe('clone');
    });
  });

  describe('failure modes', () => {
    it('Given a file with no JSDoc, When parsed, Then returns no-jsdoc-at-top', () => {
      // Arrange
      const source = "// regular comment\nimport 'x';\n";

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) expect(sut.error.reason).toBe('no-jsdoc-at-top');
    });

    it('Given an import before the JSDoc, When parsed, Then returns no-jsdoc-at-top because /** is not first', () => {
      // Arrange
      const source =
        "import 'x';\n/**\n * @proves\n *   surface: clone\n *   bucket: real-http\n *   unique: enough characters here for the bound\n */\n";

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) expect(sut.error.reason).toBe('no-jsdoc-at-top');
    });

    it('Given a JSDoc without @proves, When parsed, Then returns no-proves-block', () => {
      // Arrange
      const source = '/**\n * Description without the directive.\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) expect(sut.error.reason).toBe('no-proves-block');
    });

    it('Given an @proves block missing the bucket key, When parsed, Then returns missing-key with bucket in detail', () => {
      // Arrange
      const source =
        '/**\n * @proves\n *   surface: clone\n *   unique: enough characters here for the bound\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) {
        expect(sut.error.reason).toBe('missing-key');
        expect(sut.error.detail).toBe('bucket');
      }
    });

    it('Given an @proves block missing all three keys, When parsed, Then returns missing-key listing each in detail', () => {
      // Arrange
      const source = '/**\n * @proves\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) {
        expect(sut.error.reason).toBe('missing-key');
        expect(sut.error.detail).toBe('surface, bucket, unique');
      }
    });

    it('Given a surface starting with uppercase, When parsed, Then returns bad-surface with the value in detail', () => {
      // Arrange
      const source =
        '/**\n * @proves\n *   surface: Clone\n *   bucket: real-http\n *   unique: smart-HTTP packfile exchange\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) {
        expect(sut.error.reason).toBe('bad-surface');
        expect(sut.error.detail).toBe('Clone');
      }
    });

    it('Given a surface longer than 41 characters, When parsed, Then returns bad-surface', () => {
      // Arrange — 42 chars: c + 41 letters
      const surface = `c${'a'.repeat(41)}`;
      const source = `/**\n * @proves\n *   surface: ${surface}\n *   bucket: real-http\n *   unique: smart-HTTP packfile exchange\n */\n`;

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) expect(sut.error.reason).toBe('bad-surface');
    });

    it('Given a bucket value outside the enum, When parsed, Then returns bad-bucket with the value in detail', () => {
      // Arrange
      const source =
        '/**\n * @proves\n *   surface: clone\n *   bucket: phantom\n *   unique: smart-HTTP packfile exchange\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) {
        expect(sut.error.reason).toBe('bad-bucket');
        expect(sut.error.detail).toBe('phantom');
      }
    });

    it('Given a unique value shorter than the minimum, When parsed, Then returns bad-unique citing the floor', () => {
      // Arrange
      const source =
        '/**\n * @proves\n *   surface: clone\n *   bucket: real-http\n *   unique: short\n */\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) {
        expect(sut.error.reason).toBe('bad-unique');
        expect(sut.error.detail).toContain('at least 12');
      }
    });

    it('Given a unique value longer than the maximum, When parsed, Then returns bad-unique citing the ceiling', () => {
      // Arrange
      const longValue = 'x'.repeat(201);
      const source = `/**\n * @proves\n *   surface: clone\n *   bucket: real-http\n *   unique: ${longValue}\n */\n`;

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) {
        expect(sut.error.reason).toBe('bad-unique');
        expect(sut.error.detail).toContain('at most 200');
      }
    });

    it('Given a JSDoc with an unterminated opener, When parsed, Then returns no-jsdoc-at-top', () => {
      // Arrange
      const source = '/**\n * @proves\n';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) expect(sut.error.reason).toBe('no-jsdoc-at-top');
    });

    it('Given an empty file, When parsed, Then returns no-jsdoc-at-top', () => {
      // Arrange
      const source = '';

      // Act
      const sut = parseProvesHeader(source, sutConfig());

      // Assert
      expect(sut.ok).toBe(false);
      if (!sut.ok) expect(sut.error.reason).toBe('no-jsdoc-at-top');
    });
  });
});
