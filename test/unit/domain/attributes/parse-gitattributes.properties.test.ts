import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AttributeRule, AttributeValue } from '../../../../src/domain/attributes/index.js';
import { parseGitattributes } from '../../../../src/domain/attributes/index.js';
import { arbAttributeLine, arbAttributesText } from './arbitraries.js';

const serializeValue = (name: string, value: AttributeValue): string => {
  if (value === true) return name;
  if (value === false) return `-${name}`;
  if (value === 'unspecified') return `!${name}`;
  return `${name}=${value.set}`;
};

const ruleToLine = (rule: AttributeRule): string =>
  [rule.pattern, ...[...rule.attributes].map(([n, v]) => serializeValue(n, v))].join(' ');

interface StructuralRule {
  readonly pattern: string;
  readonly anchored: boolean;
  readonly directoryOnly: boolean;
  readonly attributes: ReadonlyArray<readonly [string, AttributeValue]>;
}

const structural = (rules: ReadonlyArray<AttributeRule>): ReadonlyArray<StructuralRule> =>
  rules.map((r) => ({
    pattern: r.pattern,
    anchored: r.anchored,
    directoryOnly: r.directoryOnly,
    attributes: [...r.attributes],
  }));

describe('parse-gitattributes properties', () => {
  describe('Given an arbitrary `.gitattributes` text', () => {
    describe('When the rules are emitted back as lines and re-parsed', () => {
      it('Then the second parse is structurally identical (round-trip idempotence)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAttributesText(), (text) => {
            const first = parseGitattributes(text);
            const second = parseGitattributes(first.rules.map(ruleToLine).join('\n'));
            expect(structural(second.rules)).toEqual(structural(first.rules));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given a pattern line of distinct-named attribute tokens', () => {
    describe('When parsed', () => {
      it('Then each token maps 1:1 to its declared name and value', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAttributeLine(), ({ line, tokens }) => {
            const { rules } = parseGitattributes(line);
            const parsed = rules[0]!.attributes;
            expect(parsed.size).toBe(tokens.length);
            for (const { name, value } of tokens) {
              expect(parsed.get(name)).toEqual(value);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
