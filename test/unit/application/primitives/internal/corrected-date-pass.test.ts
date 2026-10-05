import { describe, expect, it } from 'vitest';
import { correctedDatePass } from '../../../../../src/application/primitives/internal/corrected-date-pass.js';
import type { LocalGraphLayer } from '../../../../../src/application/primitives/internal/local-commit-graph-layers.js';
import { parseCommitGraphLayer } from '../../../../../src/domain/commit/commit-graph.js';
import {
  type CorrectedDatePass,
  serializeCommitGraph,
} from '../../../../../src/domain/commit/commit-graph-writer.js';
import { SHA1_CONFIG } from '../../../../../src/domain/objects/hash-config.js';
import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const id = (digit: string): ObjectId => digit.repeat(40) as ObjectId;

/** A one-commit layer, carrying GDA2 unless its pass was skipped. */
function layerWritten(pass: CorrectedDatePass): LocalGraphLayer {
  const commit = { id: id('a'), rootTree: id('b'), parents: [], committerDate: 1 };
  const bytes = serializeCommitGraph([commit], SHA1_CONFIG, undefined, undefined, undefined, pass);
  return { hash: id('c'), path: 'graph', layer: parseCommitGraphLayer(bytes) };
}

const WITH_DATES = layerWritten('trusted');
const LEVELS_ONLY = layerWritten('skipped');

async function contextWithVersion(version: string | undefined): Promise<Context> {
  const ctx = await buildSeededContext();
  if (version === undefined) return ctx;
  const config = `[commitGraph]\n\tgenerationVersion = ${version}\n`;
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return ctx;
}

describe('correctedDatePass', () => {
  describe.each([
    {
      label: 'no graph and no version set',
      version: undefined,
      chain: [],
      base: [],
      pass: 'trusted',
    },
    { label: 'a malformed version', version: 'two', chain: [], base: [], pass: 'trusted' },
    { label: 'version 1 and no base', version: '1', chain: [], base: [], pass: 'skipped' },
    { label: 'version 3 and no base', version: '3', chain: [], base: [], pass: 'skipped' },
    {
      label: 'version 3 over a base whose top layer carries GDA2',
      version: '3',
      chain: [WITH_DATES],
      base: [WITH_DATES],
      pass: 'trusted',
    },
    {
      label: 'version 1 over a base whose top layer carries GDA2',
      version: '1',
      chain: [WITH_DATES],
      base: [WITH_DATES],
      pass: 'skipped',
    },
    {
      label: 'a base whose top layer lacks GDA2',
      version: undefined,
      chain: [WITH_DATES, LEVELS_ONLY],
      base: [WITH_DATES, LEVELS_ONLY],
      pass: 'skipped',
    },
    {
      label: 'a folded tip layer lacking GDA2 over a base carrying it',
      version: undefined,
      chain: [WITH_DATES, LEVELS_ONLY],
      base: [WITH_DATES],
      pass: 'untrusted',
    },
    {
      label: 'a single-file write over a chain whose base lacks GDA2',
      version: undefined,
      chain: [LEVELS_ONLY, WITH_DATES],
      base: [],
      pass: 'untrusted',
    },
  ] as const)('Given $label', ({ version, chain, base, pass }) => {
    describe('When the pass is resolved', () => {
      it(`Then it is ${pass}`, async () => {
        // Arrange
        const ctx = await contextWithVersion(version);
        const sut = correctedDatePass;

        // Act
        const result = await sut(ctx, chain, base);

        // Assert
        expect(result).toBe(pass);
      });
    });
  });
});
