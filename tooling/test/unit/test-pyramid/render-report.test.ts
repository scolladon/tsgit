import { describe, expect, it } from 'vitest';
import type { AuditOutcome } from '../../../test-pyramid/render-report.js';
import { renderJson, renderMarkdown } from '../../../test-pyramid/render-report.js';

const okOutcome: AuditOutcome = {
  tally: {
    tiers: [
      {
        tier: 'unit',
        fileCount: 8,
        sharePct: 80.0,
        target: 80,
        warnBelow: 75,
        warnAbove: null,
        status: 'ok',
      },
      {
        tier: 'integration',
        fileCount: 1,
        sharePct: 10.0,
        target: 15,
        warnBelow: 10,
        warnAbove: 25,
        status: 'warn-below',
      },
      {
        tier: 'e2e',
        fileCount: 1,
        sharePct: 10.0,
        target: 5,
        warnBelow: 3,
        warnAbove: null,
        status: 'ok',
      },
    ],
    unclassified: [],
    totalClassified: 10,
  },
  findings: {
    overMocked: [],
    underAsserted: [],
    badTitle: [],
    missingAaa: [],
    bannedSut: [],
    bareClassThrow: [],
    emptyAaaSection: [],
    integrationProof: { missing: [], duplicate: [], misplaced: [], accepted: [] },
  },
  excludePaths: [],
};

const outcomeWithFindings: AuditOutcome = {
  ...okOutcome,
  findings: {
    overMocked: [{ path: 'test/integration/clone.test.ts', hits: 2 }],
    underAsserted: [
      { path: 'test/unit/a.test.ts', line: 42, title: 'does nothing' },
      { path: 'test/unit/b.test.ts', line: 7, title: 'no assert' },
    ],
    badTitle: [
      {
        path: 'test/unit/c.test.ts',
        line: 9,
        title: 'no gwt here',
        ancestors: ['When op runs', 'Given a sut'],
        reason: 'then-missing',
      },
    ],
    missingAaa: [
      {
        path: 'test/unit/d.test.ts',
        line: 11,
        title: 'Given x, When y, Then z',
        missing: ['Arrange'],
      },
    ],
    bannedSut: [
      {
        path: 'test/unit/e.test.ts',
        line: 13,
        title: 'Given x, When y, Then z',
        alias: 'subject',
      },
    ],
    bareClassThrow: [
      {
        path: 'test/unit/f.test.ts',
        line: 15,
        title: 'Given x, When y, Then z',
        identifier: 'TsgitError',
      },
    ],
    emptyAaaSection: [
      {
        path: 'test/unit/g.test.ts',
        line: 17,
        title: 'Given x, When y, Then z',
        marker: 'Arrange',
      },
    ],
    integrationProof: { missing: [], duplicate: [], misplaced: [], accepted: [] },
  },
};

describe('renderJson', () => {
  it('Given a clean outcome, When rendered as JSON, Then output is valid JSON with the expected shape', () => {
    // Arrange + Act
    const sut = JSON.parse(renderJson(okOutcome));

    // Assert
    expect(sut.tally.totalClassified).toBe(10);
    expect(sut.findings.overMocked).toEqual([]);
    expect(sut.findings.underAsserted).toEqual([]);
  });

  it('Given findings, When rendered as JSON, Then findings are serialised verbatim', () => {
    // Arrange + Act
    const sut = JSON.parse(renderJson(outcomeWithFindings));

    // Assert
    expect(sut.findings.overMocked).toHaveLength(1);
    expect(sut.findings.underAsserted).toHaveLength(2);
    expect(sut.findings.underAsserted[1].title).toBe('no assert');
  });

  it('Given any outcome, When rendered, Then output ends with a newline', () => {
    // Arrange + Act
    const sut = renderJson(okOutcome);

    // Assert
    expect(sut.endsWith('\n')).toBe(true);
  });
});

describe('renderMarkdown', () => {
  it('Given a clean outcome, When rendered, Then markdown contains a tier table row per tier', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert
    expect(sut).toContain('| unit |');
    expect(sut).toContain('| integration |');
    expect(sut).toContain('| e2e |');
  });

  it('Given a tier with warn-below status, When rendered, Then its row contains a warning marker', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert — integration is warn-below in okOutcome
    const integrationRow = sut.split('\n').find((line) => line.includes('| integration |'));
    expect(integrationRow).toBeDefined();
    expect(integrationRow).toContain('⚠ warn-below');
  });

  it('Given findings, When rendered, Then a Findings section lists over-mocked and under-asserted entries', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('## Findings');
    expect(sut).toContain('test/integration/clone.test.ts');
    expect(sut).toContain('test/unit/a.test.ts');
    expect(sut).toContain('does nothing');
  });

  it('Given a clean outcome with zero findings, When rendered, Then findings sections are rendered as "_none_"', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert
    expect(sut).toMatch(/Over-mocked[\s\S]*_none_/);
    expect(sut).toMatch(/Under-asserted[\s\S]*_none_/);
  });

  it('Given an outcome where no files were classified, When rendered, Then the report notes "no tests classified"', () => {
    // Arrange
    const empty: AuditOutcome = {
      tally: {
        tiers: okOutcome.tally.tiers.map((t) => ({
          ...t,
          fileCount: 0,
          sharePct: 0,
          status: 'warn-below',
        })),
        unclassified: [],
        totalClassified: 0,
      },
      findings: {
        overMocked: [],
        underAsserted: [],
        badTitle: [],
        missingAaa: [],
        bannedSut: [],
        bareClassThrow: [],
        emptyAaaSection: [],
        integrationProof: { missing: [], duplicate: [], misplaced: [], accepted: [] },
      },
      excludePaths: [],
    };

    // Act
    const sut = renderMarkdown(empty);

    // Assert
    expect(sut.toLowerCase()).toContain('no tests classified');
  });

  it('Given an outcome with unclassified files, When rendered, Then they appear in an "Unclassified" section', () => {
    // Arrange
    const withUnclassified: AuditOutcome = {
      ...okOutcome,
      tally: { ...okOutcome.tally, unclassified: ['test/odd-file.ts'] },
    };

    // Act
    const sut = renderMarkdown(withUnclassified);

    // Assert
    expect(sut).toContain('test/odd-file.ts');
    expect(sut.toLowerCase()).toContain('unclassified');
  });

  it('Given a tier with warn-above status, When rendered, Then its row contains the literal "⚠ warn-above" badge', () => {
    // Arrange
    const overAbove: AuditOutcome = {
      ...okOutcome,
      tally: {
        ...okOutcome.tally,
        tiers: okOutcome.tally.tiers.map((t) =>
          t.tier === 'integration' ? { ...t, sharePct: 40.0, status: 'warn-above' as const } : t,
        ),
      },
    };

    // Act
    const sut = renderMarkdown(overAbove);

    // Assert
    const integrationRow = sut.split('\n').find((line) => line.includes('| integration |'));
    expect(integrationRow).toBeDefined();
    expect(integrationRow).toContain('⚠ warn-above');
  });

  it('Given a tier with no warnAbove, When rendered, Then its warn-band cell omits the upper bound', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert — unit has warnAbove: null; row should NOT show "≤ N%"
    const unitRow = sut.split('\n').find((line) => line.includes('| unit |'));
    expect(unitRow).toBeDefined();
    expect(unitRow).toContain('≥ 75%');
    expect(unitRow).not.toContain('≤');
  });

  it('Given a tier with both warnBelow and warnAbove, When rendered, Then its warn-band cell shows "≥ N% / ≤ M%"', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert
    const integrationRow = sut.split('\n').find((line) => line.includes('| integration |'));
    expect(integrationRow).toBeDefined();
    expect(integrationRow).toContain('≥ 10% / ≤ 25%');
  });

  it('Given any outcome, When rendered, Then output ends with a single newline', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert
    expect(sut.endsWith('\n')).toBe(true);
    expect(sut.endsWith('\n\n')).toBe(false);
  });

  it('Given findings for each new heuristic, When rendered, Then markdown contains a section header per heuristic', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('### Non-GWT unit test titles');
    expect(sut).toContain('### Missing AAA body comments');
    expect(sut).toContain('### Banned SUT name synonyms');
    expect(sut).toContain('### Bare-class `.toThrow(Class)` calls');
    expect(sut).toContain('### Empty AAA sections');
  });

  it('Given a bad-title finding, When rendered, Then the row names the reason, the title, and the GWT ancestry', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('test/unit/c.test.ts:9');
    expect(sut).toContain('then-missing: no gwt here');
    expect(sut).toContain('[under: When op runs < Given a sut]');
  });

  it('Given a missing-AAA finding, When rendered, Then the row lists the missing markers', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('test/unit/d.test.ts:11');
    expect(sut).toContain('missing Arrange');
  });

  it('Given a banned-sut finding, When rendered, Then the row names the alias', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('test/unit/e.test.ts:13');
    expect(sut).toContain('`subject` should be `sut`');
  });

  it('Given a bare-class throw finding, When rendered, Then the row names the identifier', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('test/unit/f.test.ts:15');
    expect(sut).toContain('`.toThrow(TsgitError)`');
  });

  it('Given an empty-AAA-section finding, When rendered, Then the row names the empty marker', () => {
    // Arrange + Act
    const sut = renderMarkdown(outcomeWithFindings);

    // Assert
    expect(sut).toContain('test/unit/g.test.ts:17');
    expect(sut).toContain('empty Arrange section');
  });

  it('Given an outcome with empty new-finding arrays, When rendered, Then each new section renders as "_none_"', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert
    expect(sut).toMatch(/Non-GWT[\s\S]*_none_/);
    expect(sut).toMatch(/Missing AAA[\s\S]*_none_/);
    expect(sut).toMatch(/Banned SUT[\s\S]*_none_/);
    expect(sut).toMatch(/Bare-class[\s\S]*_none_/);
    expect(sut).toMatch(/Empty AAA sections[\s\S]*_none_/);
  });
});
