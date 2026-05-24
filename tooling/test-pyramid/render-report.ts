/**
 * Report renderer.
 *
 * Two emitters: machine-readable JSON and human-readable Markdown. Both pure.
 */
import type { BadTitleFinding } from './detect-bad-title.ts';
import type { BannedSutFinding } from './detect-banned-sut-name.ts';
import type { BareClassThrowFinding } from './detect-bare-class-throw.ts';
import type { EmptyAaaSectionFinding } from './detect-empty-aaa-section.ts';
import type { MissingAaaFinding } from './detect-missing-aaa.ts';
import type { OverMockedFinding } from './detect-over-mocked.ts';
import type { UnderAssertedFinding } from './detect-under-asserted.ts';
import type { TallyResult, TierStatus, TierTally } from './count-tier-files.ts';

export interface AuditFindings {
  readonly overMocked: ReadonlyArray<OverMockedFinding>;
  readonly underAsserted: ReadonlyArray<UnderAssertedFinding>;
  readonly badTitle: ReadonlyArray<BadTitleFinding>;
  readonly missingAaa: ReadonlyArray<MissingAaaFinding>;
  readonly bannedSut: ReadonlyArray<BannedSutFinding>;
  readonly bareClassThrow: ReadonlyArray<BareClassThrowFinding>;
  readonly emptyAaaSection: ReadonlyArray<EmptyAaaSectionFinding>;
}

export interface AuditOutcome {
  readonly tally: TallyResult;
  readonly findings: AuditFindings;
  readonly excludePaths: ReadonlyArray<string>;
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
  return findings
    .map((f) => `- \`${f.path}\` — ${f.hits} hit${f.hits === 1 ? '' : 's'}`)
    .join('\n');
};

const renderUnderAsserted = (findings: ReadonlyArray<UnderAssertedFinding>): string => {
  if (findings.length === 0) return '_none_';
  return findings.map((f) => `- \`${f.path}:${f.line}\` — ${f.title}`).join('\n');
};

const renderBadTitle = (findings: ReadonlyArray<BadTitleFinding>): string => {
  if (findings.length === 0) return '_none_';
  return findings
    .map((f) => `- \`${f.path}:${f.line}\` — ${f.reason}: ${f.title}`)
    .join('\n');
};

const renderMissingAaa = (findings: ReadonlyArray<MissingAaaFinding>): string => {
  if (findings.length === 0) return '_none_';
  return findings
    .map((f) => `- \`${f.path}:${f.line}\` — missing ${f.missing.join(', ')} (${f.title})`)
    .join('\n');
};

const renderBannedSut = (findings: ReadonlyArray<BannedSutFinding>): string => {
  if (findings.length === 0) return '_none_';
  return findings
    .map((f) => `- \`${f.path}:${f.line}\` — \`${f.alias}\` should be \`sut\` (${f.title})`)
    .join('\n');
};

const renderBareClassThrow = (
  findings: ReadonlyArray<BareClassThrowFinding>,
): string => {
  if (findings.length === 0) return '_none_';
  return findings
    .map(
      (f) =>
        `- \`${f.path}:${f.line}\` — \`.toThrow(${f.identifier})\` needs a data assertion (${f.title})`,
    )
    .join('\n');
};

const renderEmptyAaaSection = (
  findings: ReadonlyArray<EmptyAaaSectionFinding>,
): string => {
  if (findings.length === 0) return '_none_';
  return findings
    .map((f) => `- \`${f.path}:${f.line}\` — empty ${f.marker} section (${f.title})`)
    .join('\n');
};

const renderUnclassified = (paths: ReadonlyArray<string>): string => {
  if (paths.length === 0) return '';
  const lines = paths.map((p) => `- \`${p}\``);
  return ['', '## Unclassified', '', ...lines].join('\n');
};

const renderExcluded = (paths: ReadonlyArray<string>): string => {
  if (paths.length === 0) return '';
  const lines = paths.map((p) => `- \`${p}\``);
  return [
    '',
    '## Excluded from heuristics',
    '',
    'Self-test fixtures intentionally embed anti-patterns. Listed here so CI',
    'reviewers can see what is being silenced.',
    '',
    ...lines,
  ].join('\n');
};

export const renderMarkdown = (outcome: AuditOutcome): string => {
  const { tally, findings } = outcome;
  const sections: string[] = ['# Testing-pyramid audit', ''];

  if (tally.totalClassified === 0) {
    sections.push('_no tests classified_');
  } else {
    sections.push(renderTierTable(tally));
  }

  // Render exclusions BEFORE the findings list so a CI summary truncation
  // doesn't hide which paths are being silenced by the audit. Reviewers see
  // the exclusion list right after the tier table.
  const excluded = renderExcluded(outcome.excludePaths);
  if (excluded.length > 0) sections.push(excluded);

  sections.push('', '## Findings');
  sections.push('', '### Over-mocked integration tests', '', renderOverMocked(findings.overMocked));
  sections.push('', '### Under-asserted unit tests', '', renderUnderAsserted(findings.underAsserted));
  sections.push('', '### Non-GWT unit test titles', '', renderBadTitle(findings.badTitle));
  sections.push('', '### Missing AAA body comments', '', renderMissingAaa(findings.missingAaa));
  sections.push(
    '',
    '### Empty AAA sections',
    '',
    renderEmptyAaaSection(findings.emptyAaaSection),
  );
  sections.push('', '### Banned SUT name synonyms', '', renderBannedSut(findings.bannedSut));
  sections.push(
    '',
    '### Bare-class `.toThrow(Class)` calls',
    '',
    renderBareClassThrow(findings.bareClassThrow),
  );

  const unclassified = renderUnclassified(tally.unclassified);
  if (unclassified.length > 0) sections.push(unclassified);

  return `${sections.join('\n')}\n`;
};
