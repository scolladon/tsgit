import { describe, expect, it } from 'vitest';
import type { AuditOutcome } from '../../../../scripts/test-pyramid/render-report.js';
import { renderJson, renderMarkdown } from '../../../../scripts/test-pyramid/render-report.js';

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
  },
};

const outcomeWithFindings: AuditOutcome = {
  ...okOutcome,
  findings: {
    overMocked: [{ path: 'test/integration/clone.test.ts', hits: 2 }],
    underAsserted: [
      { path: 'test/unit/a.test.ts', line: 42, title: 'does nothing' },
      { path: 'test/unit/b.test.ts', line: 7, title: 'no assert' },
    ],
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
    expect(integrationRow).toMatch(/⚠|warn-below/);
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
      findings: { overMocked: [], underAsserted: [] },
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

  it('Given any outcome, When rendered, Then output ends with a single newline', () => {
    // Arrange + Act
    const sut = renderMarkdown(okOutcome);

    // Assert
    expect(sut.endsWith('\n')).toBe(true);
    expect(sut.endsWith('\n\n')).toBe(false);
  });
});
