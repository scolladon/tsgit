/**
 * Report renderer.
 *
 * Two emitters: machine-readable JSON and human-readable Markdown. Both pure.
 */
import type { OverMockedFinding } from './detect-over-mocked.ts';
import type { UnderAssertedFinding } from './detect-under-asserted.ts';
import type { TallyResult, TierStatus, TierTally } from './count-tier-files.ts';

export interface AuditOutcome {
  readonly tally: TallyResult;
  readonly findings: {
    readonly overMocked: ReadonlyArray<OverMockedFinding>;
    readonly underAsserted: ReadonlyArray<UnderAssertedFinding>;
  };
}

const STATUS_BADGE: Record<TierStatus, string> = {
  ok: '✓',
  'warn-below': '⚠ warn-below',
  'warn-above': '⚠ warn-above',
};

export const renderJson = (outcome: AuditOutcome): string =>
  `${JSON.stringify(outcome, null, 2)}\n`;

const formatRange = (tier: TierTally): string => {
  const lower = `≥ ${tier.warnBelow}%`;
  const upper = tier.warnAbove === null ? '' : ` / ≤ ${tier.warnAbove}%`;
  return `${lower}${upper}`;
};

const renderTierRow = (tier: TierTally): string => {
  const shareLabel = `${tier.sharePct.toFixed(1)}%`;
  const targetLabel = `${tier.target}%`;
  const range = formatRange(tier);
  return `| ${tier.tier} | ${tier.fileCount} | ${shareLabel} | ${targetLabel} | ${range} | ${STATUS_BADGE[tier.status]} |`;
};

const renderTierTable = (tally: TallyResult): string => {
  const header = [
    '| Tier | Files | Share | Target | Warn band | Status |',
    '|---|---:|---:|---:|---|---|',
  ];
  const rows = tally.tiers.map(renderTierRow);
  return [...header, ...rows].join('\n');
};

const renderOverMocked = (findings: ReadonlyArray<OverMockedFinding>): string => {
  if (findings.length === 0) return '_none_';
  return findings.map((f) => `- \`${f.path}\` — ${f.hits} hit${f.hits === 1 ? '' : 's'}`).join('\n');
};

const renderUnderAsserted = (findings: ReadonlyArray<UnderAssertedFinding>): string => {
  if (findings.length === 0) return '_none_';
  return findings.map((f) => `- \`${f.path}:${f.line}\` — ${f.title}`).join('\n');
};

const renderUnclassified = (paths: ReadonlyArray<string>): string => {
  if (paths.length === 0) return '';
  const lines = paths.map((p) => `- \`${p}\``);
  return ['', '## Unclassified', '', ...lines].join('\n');
};

export const renderMarkdown = (outcome: AuditOutcome): string => {
  const { tally, findings } = outcome;
  const sections: string[] = ['# Testing-pyramid audit', ''];

  if (tally.totalClassified === 0) {
    sections.push('_no tests classified_');
  } else {
    sections.push(renderTierTable(tally));
  }

  sections.push('', '## Findings');
  sections.push('', '### Over-mocked integration tests', '', renderOverMocked(findings.overMocked));
  sections.push('', '### Under-asserted unit tests', '', renderUnderAsserted(findings.underAsserted));

  const unclassified = renderUnclassified(tally.unclassified);
  if (unclassified.length > 0) sections.push(unclassified);

  return `${sections.join('\n')}\n`;
};
