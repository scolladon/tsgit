import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import { parseV2Capabilities } from '../../../../../src/domain/protocol/v2/capabilities.js';
import { agentArb, commandSetArb, fetchFeaturesArb } from './arbitraries.js';

const ENCODER = new TextEncoder();

async function* streamOf(lines: ReadonlyArray<string>): AsyncIterable<PktLine> {
  for (const line of lines) {
    yield { kind: 'data', payload: ENCODER.encode(line) };
  }
  yield { kind: 'flush' };
}

const buildAdvertisementLines = (
  agent: string | undefined,
  commands: ReadonlyArray<string>,
  fetchFeatures: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const agentLine = agent === undefined ? [] : [`agent=${agent}\n`];
  const commandLines = commands.map((command) =>
    command === 'fetch' && fetchFeatures.length > 0
      ? `fetch=${fetchFeatures.join(' ')}\n`
      : `${command}\n`,
  );
  return ['version 2\n', ...agentLine, ...commandLines, 'object-format=sha1\n'];
};

describe('Given an arbitrary agent, command set, and fetch feature set', () => {
  describe('When serialized to a v2 capability advertisement and parsed via parseV2Capabilities', () => {
    it('Then the parsed command set and fetch feature set map 1:1 to the input', async () => {
      // Arrange
      const sut = parseV2Capabilities;

      // Act & Assert
      await fc.assert(
        fc.asyncProperty(
          fc.option(agentArb(), { nil: undefined }),
          commandSetArb(),
          fetchFeaturesArb(),
          async (agent, commands, fetchFeatures) => {
            const effectiveFeatures = commands.includes('fetch') ? fetchFeatures : [];
            const lines = buildAdvertisementLines(agent, commands, effectiveFeatures);

            const result = await sut(streamOf(lines));

            expect(result.version).toBe(2);
            expect(result.agent).toBe(agent);
            expect(result.objectFormat).toBe('sha1');
            expect([...result.commands].sort()).toEqual([...commands].sort());
            expect([...result.fetchFeatures].sort()).toEqual([...effectiveFeatures].sort());
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
