/**
 * Assemble a non-merge commit's pretty-formatted text: the header (built-in or
 * custom-template) followed by the optionally-attached diff, framed per the
 * format (§`pretty-format.ts`). Merge commits keep the medium/combined path
 * (their diff is combined, not a single patch).
 */
import type { CommitData, ObjectId } from '../objects/index.js';
import type { DateMode } from './date-mode.js';
import type { DecorationRef } from './decoration.js';
import type { DateFormatter } from './identity-header.js';
import { type BuiltinParts, renderBuiltinHeader } from './pretty-builtin.js';
import { framingFor, type PrettyFormat } from './pretty-format.js';
import { buildCommitFields, expandTemplate } from './pretty-placeholders.js';

export interface PrettyCommitContext {
  readonly id: ObjectId;
  readonly commit: CommitData;
  readonly formatDate: DateFormatter;
  readonly dateMode: DateMode;
  readonly now: number;
  readonly refs: ReadonlyArray<DecorationRef>;
  readonly headBranch?: string;
  readonly detachedHead?: boolean;
}

export interface PrettyDiffOptions {
  readonly patchText?: string;
  readonly noPatch: boolean;
}

const headerBody = (format: PrettyFormat, ctx: PrettyCommitContext): string => {
  if (format.kind === 'custom') {
    return expandTemplate(
      format.template,
      buildCommitFields({
        id: ctx.id,
        commit: ctx.commit,
        dateMode: ctx.dateMode,
        now: ctx.now,
        refs: ctx.refs,
        ...(ctx.headBranch !== undefined ? { headBranch: ctx.headBranch } : {}),
        ...(ctx.detachedHead === true ? { detachedHead: true } : {}),
      }),
    );
  }
  const parts: BuiltinParts = {
    id: ctx.id,
    commit: ctx.commit,
    formatDate: ctx.formatDate,
    now: ctx.now,
  };
  return renderBuiltinHeader(format.name, parts);
};

export function renderPrettyCommit(
  format: PrettyFormat,
  ctx: PrettyCommitContext,
  diff: PrettyDiffOptions,
): string {
  const body = headerBody(format, ctx);
  const framing = framingFor(format);
  if (diff.noPatch || diff.patchText === undefined) {
    return framing.terminator ? `${body}\n` : body;
  }
  const separator = framing.blankBeforePatch ? '\n\n' : '\n';
  return `${body}${separator}${diff.patchText}`;
}
