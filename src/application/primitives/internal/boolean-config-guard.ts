import { configBadBooleanLiteral, configBadBooleanValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findFirstInvalidBoolean, findFirstInvalidBooleanInSection } from '../config-read.js';

/**
 * Refuse with `CONFIG_BAD_BOOLEAN_VALUE` when any of `keys` (case-insensitive) under
 * `[<section> "<subsection>"]` holds a value git's boolean grammar refuses, reporting
 * the FIRST such entry by config-file line. Returns normally for a valid value, a
 * valueless key (git's internal NULL, always true), an absent key, or an out-of-section
 * key. The exact sibling of `assertNoValuelessConfig`, one class over.
 */
export const assertValidBooleanConfig = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<void> => {
  const found = await findFirstInvalidBoolean(ctx, section, subsection, keys);
  if (found !== undefined) throw configBadBooleanValue(found.key, found.source, found.value);
};

/**
 * Subsection-wildcard sibling of `assertValidBooleanConfig`: scans EVERY subsection of
 * `section` (the per-instance families — `submodule.<n>.*`, `remote.<n>.*`) rather than
 * one exact subsection.
 */
export const assertValidBooleanConfigInSection = async (
  ctx: Context,
  section: string,
  keys: ReadonlyArray<string>,
): Promise<void> => {
  const found = await findFirstInvalidBooleanInSection(ctx, section, keys);
  if (found !== undefined) throw configBadBooleanValue(found.key, found.source, found.value);
};

/**
 * `push.gpgSign`'s tri-state literal check: shares `assertValidBooleanConfig`'s finder
 * (so the two can never disagree about *what* is invalid) but throws the distinct
 * `CONFIG_BAD_BOOLEAN_LITERAL` code, because git reports a different message
 * (`invalid value for '<key>'`) for this one key.
 */
export const assertValidBooleanLiteral = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<void> => {
  const found = await findFirstInvalidBoolean(ctx, section, subsection, keys);
  if (found !== undefined) throw configBadBooleanLiteral(found.key, found.source, found.value);
};
