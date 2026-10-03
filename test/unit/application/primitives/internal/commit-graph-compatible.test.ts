import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  hasGrafts,
  hasReplaceRefs,
} from '../../../../../src/application/primitives/internal/commit-graph-compatible.js';

const OID = 'a'.repeat(40);
const PARENT = 'B'.repeat(40);

describe('hasGrafts', () => {
  describe.each([
    { label: 'no grafts file', grafts: undefined, expected: false },
    { label: 'a commit alone', grafts: `${OID}\n`, expected: true },
    { label: 'a commit and an upper-case parent', grafts: `${OID} ${PARENT}\n`, expected: true },
    { label: 'trailing blanks after the oids', grafts: `${OID} \t\n`, expected: true },
    { label: 'only comments and blank lines', grafts: `# ${OID}\n\n`, expected: false },
    { label: 'a short oid', grafts: `${OID.slice(1)}\n`, expected: false },
    { label: 'a parent with no separator', grafts: `${OID}${PARENT}\n`, expected: false },
    { label: 'leading text before the oid', grafts: `x${OID}\n`, expected: false },
    { label: 'trailing text after the oid', grafts: `${OID} x\n`, expected: false },
  ])('Given $label', ({ grafts, expected }) => {
    describe('When checked', () => {
      it(`Then it answers ${expected}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        if (grafts !== undefined)
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/grafts`, grafts);
        const sut = hasGrafts;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('hasReplaceRefs', () => {
  describe.each([
    { label: 'no replace ref', ref: undefined, config: '', expected: false },
    { label: 'a replace ref', ref: `refs/replace/${OID}`, config: '', expected: true },
    {
      label: 'a replace ref not named by an oid',
      ref: 'refs/replace/topic',
      config: '',
      expected: false,
    },
    {
      label: 'a replace ref under core.useReplaceRefs=true',
      ref: `refs/replace/${OID}`,
      config: '[core]\n\tuseReplaceRefs = true\n',
      expected: true,
    },
    {
      label: 'a replace ref under a valueless core.useReplaceRefs',
      ref: `refs/replace/${OID}`,
      config: '[core]\n\tuseReplaceRefs\n',
      expected: true,
    },
    {
      label: 'a replace ref under core.useReplaceRefs=false',
      ref: `refs/replace/${OID}`,
      config: '[core]\n\tuseReplaceRefs = false\n',
      expected: false,
    },
    { label: 'a branch alone', ref: `refs/heads/${OID}`, config: '', expected: false },
  ])('Given $label', ({ ref, config, expected }) => {
    describe('When checked', () => {
      it(`Then it answers ${expected}`, async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        if (ref !== undefined) {
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/packed-refs`, `${OID} ${ref}\n`);
        }
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, config);
        const sut = hasReplaceRefs;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
