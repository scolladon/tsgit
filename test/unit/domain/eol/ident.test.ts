import { describe, expect, it } from 'vitest';

import { identToGit, identToWorkingTree } from '../../../../src/domain/eol/ident.js';

const bytes = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

const text = (data: Uint8Array): string => String.fromCharCode(...data);

describe('identToGit', () => {
  describe.each([
    ['a keyword with a value', '$Id: deadbeef $\n', '$Id$\n'],
    ['a keyword with garbage', '$Id:garbage$\n', '$Id$\n'],
    ['a foreign keyword with inner spaces', '$Id: has space x $\n', '$Id$\n'],
    ['an empty-valued keyword', '$Id:$\n', '$Id$\n'],
    ['text around a keyword', 'x $Id: a $ y', 'x $Id$ y'],
    ['two adjacent keywords', '$Id: a $$Id: b $', '$Id$$Id$'],
    ['a keyword after a lone dollar', '$$Id: a $', '$$Id$'],
  ])('Given %s', (_title, input, expected) => {
    describe('When collapsed', () => {
      it('Then the value is dropped', () => {
        // Arrange
        const source = bytes(input);

        // Act
        const result = identToGit(source);

        // Assert
        expect(text(result)).toBe(expected);
      });
    });
  });

  describe.each([
    ['a LF before the closing dollar', '$Id: nl\n$ $Id$'],
    ['no closing dollar', '$Id: abc'],
    ['a bare keyword', '$Id$\n'],
    ['a keyword cut after the name', '$Id\n'],
    ['no dollar at all', 'plain\n'],
    ['an empty input', ''],
    ['a short tail after a dollar', 'a $Id:'],
  ])('Given %s', (_title, input) => {
    describe('When collapsed', () => {
      it('Then the very same bytes are returned', () => {
        // Arrange
        const source = bytes(input);

        // Act
        const result = identToGit(source);

        // Assert
        expect(result).toBe(source);
      });
    });
  });

  describe('Given a LF-split keyword followed by a real keyword', () => {
    describe('When collapsed', () => {
      it('Then only the real keyword is collapsed', () => {
        // Arrange
        const source = bytes('$Id: nl\n$ $Id: v $');

        // Act
        const result = identToGit(source);

        // Assert
        expect(text(result)).toBe('$Id: nl\n$ $Id$');
      });
    });
  });
});

const OID = '08a4620a27060eb3dbee93734f82d9146bfd1b4d';
const OID_256 = '746298a10ca2cb9f978433b2e3ccb0dc69fe53a9838ef2ed765be6d8b780a98d';

describe('identToWorkingTree', () => {
  describe.each([
    ['a bare keyword', 'x $Id$ y\n', `x $Id: ${OID} $ y\n`],
    ['a valued keyword', '$Id: deadbeef $\n', `$Id: ${OID} $\n`],
    ['a garbage keyword', '$Id:garbage$\n', `$Id: ${OID} $\n`],
    ['an empty-valued keyword', '$Id:$', `$Id: ${OID} $`],
    ['a LF-split keyword then a bare one', '$Id: nl\n$ $Id$', `$Id: nl\n$ $Id: ${OID} $`],
    ['binary content', 'a\0$Id$', `a\0$Id: ${OID} $`],
    ['two adjacent keywords', '$Id$$Id$', `$Id: ${OID} $$Id: ${OID} $`],
    ['a lone dollar before a keyword', '$$Id$\n', `$$Id: ${OID} $\n`],
    ['a foreign keyword with a space', '$Id:a b$', '$Id:a b$'],
    ['a foreign keyword with inner spaces', '$Id: has space x $\n', '$Id: has space x $\n'],
    ['a keyword whose only space is last', '$Id:ab $', `$Id: ${OID} $`],
    ['a keyword whose only space is first', '$Id: ab$', `$Id: ${OID} $`],
    ['a tab-separated value', '$Id: a\tb $', `$Id: ${OID} $`],
    ['a keyword cut after the name', '$Id\n', '$Id\n'],
    ['an unterminated colon keyword', '$Id: abc', '$Id: abc'],
    ['a name followed by another byte', '$Idx$', '$Idx$'],
  ])('Given %s', (_title, input, expected) => {
    describe('When expanded', () => {
      it('Then the working-tree bytes match', () => {
        // Arrange
        const source = bytes(input);

        // Act
        const result = identToWorkingTree(source, OID);

        // Assert
        expect(text(result)).toBe(expected);
      });
    });
  });

  describe.each([
    ['no dollar', 'plain'],
    ['an empty input', ''],
    ['a foreign keyword', '$Id:a b$'],
    ['a LF-split keyword', '$Id: nl\n$'],
  ])('Given %s', (_title, input) => {
    describe('When expanded', () => {
      it('Then the very same bytes are returned', () => {
        // Arrange
        const source = bytes(input);

        // Act
        const result = identToWorkingTree(source, OID);

        // Assert
        expect(result).toBe(source);
      });
    });
  });

  describe('Given the divergence blob', () => {
    describe('When expanded in core', () => {
      it('Then it expands $$Id$, keeps $Id:a b$ and replaces the tab keyword', () => {
        // Arrange
        const source = bytes('$$Id$\n$Id:a b$\n$Id: a\tb $\n$Id$Id$\n');

        // Act
        const result = identToWorkingTree(source, OID);

        // Assert
        expect(text(result)).toBe(`$$Id: ${OID} $\n$Id:a b$\n$Id: ${OID} $\n$Id: ${OID} $Id$\n`);
      });
    });
  });

  describe('Given a 64-hex object id', () => {
    describe('When expanded', () => {
      it('Then the keyword carries the full width', () => {
        // Arrange
        const source = bytes('$Id$\n');

        // Act
        const result = identToWorkingTree(source, OID_256);

        // Assert
        expect(text(result)).toBe(`$Id: ${OID_256} $\n`);
      });
    });
  });
});

describe('Given a 1 MiB LF-free blob of back-to-back $Id: keywords', () => {
  const MIB = 1024 * 1024;
  const LINEAR_BUDGET_MS = 2_000;
  const blob = new TextEncoder().encode('$Id:x'.repeat(MIB / 5));

  describe('When collapsed', () => {
    it('Then every keyword collapses within a linear-time budget', () => {
      // Arrange
      const sut = identToGit;
      const started = performance.now();

      // Act
      const result = sut(blob);

      // Assert
      expect(performance.now() - started).toBeLessThan(LINEAR_BUDGET_MS);
      expect(result.length).toBeLessThan(blob.length);
    });
  });

  describe('When expanded in core', () => {
    it('Then every keyword expands within a linear-time budget', () => {
      // Arrange
      const sut = identToWorkingTree;
      const started = performance.now();

      // Act
      const result = sut(blob, OID);

      // Assert
      expect(performance.now() - started).toBeLessThan(LINEAR_BUDGET_MS);
      expect(result.length).toBeGreaterThan(blob.length);
    });
  });
});
