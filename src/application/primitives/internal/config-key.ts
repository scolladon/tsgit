import type { ConfigScope, ParsedConfigKey } from '../../../domain/commands/config-key.js';
import type { IniSection } from '../config-read.js';

/**
 * Render a fully-qualified key string from a config section header + raw entry
 * name. Section and name are lower-cased; subsection is preserved verbatim
 * (case-sensitive, per git's grammar).
 *
 * An orphan key (empty section, no subsection) renders as the bare lowered name
 * with no leading dot — git dumps sectionless keys without a prefix. This is
 * distinct from `[ ""]` (empty section *with* an empty subsection), which keeps
 * its `.name` shape.
 */
export const qualifyKey = (section: IniSection, rawName: string): string => {
  const lowerName = rawName.toLowerCase();
  if (section.section === '' && section.subsection === undefined) return lowerName;
  const lowerSection = section.section.toLowerCase();
  if (section.subsection === undefined) return `${lowerSection}.${lowerName}`;
  return `${lowerSection}.${section.subsection}.${lowerName}`;
};

const matchesSectionHeader = (section: IniSection, parsed: ParsedConfigKey): boolean => {
  if (section.section.toLowerCase() !== parsed.section) return false;
  // Stryker disable next-line ConditionalExpression: equivalent — when parsed.subsection===undefined the fallthrough `section.subsection === parsed.subsection` is `section.subsection === undefined`, identical to this guard's return
  if (parsed.subsection === undefined) return section.subsection === undefined;
  return section.subsection === parsed.subsection;
};

/**
 * Walk a flat sections array and collect the values whose qualified key matches
 * `parsed`. Entries are returned in physical (file) order.
 *
 * The `value` field carries `string | null`: `null` means the key was present
 * with no `=` (git's internal NULL); `undefined` is never used here.
 */
export const collectValues = (
  sections: ReadonlyArray<IniSection>,
  parsed: ParsedConfigKey,
): ReadonlyArray<{ readonly value: string | null }> => {
  const matches: Array<{ value: string | null }> = [];
  for (const section of sections) {
    if (!matchesSectionHeader(section, parsed)) continue;
    for (const entry of section.entries) {
      if (entry.key.toLowerCase() === parsed.name) matches.push({ value: entry.value });
    }
  }
  return matches;
};

/**
 * Walk a scope-tagged sections array and collect matches tagged with the scope
 * they came from. Caller order is preserved, so wrapping with
 * `mergeConfigsByScope` yields scope-precedence order.
 *
 * The `value` field carries `string | null`: `null` means the key was present
 * with no `=` (git's internal NULL); `undefined` is never used here.
 */
export const collectScopedValues = (
  scopedSections: ReadonlyArray<{ readonly scope: ConfigScope; readonly section: IniSection }>,
  parsed: ParsedConfigKey,
): ReadonlyArray<{ readonly value: string | null; readonly scope: ConfigScope }> => {
  const matches: Array<{ value: string | null; scope: ConfigScope }> = [];
  for (const { scope, section } of scopedSections) {
    if (!matchesSectionHeader(section, parsed)) continue;
    for (const entry of section.entries) {
      if (entry.key.toLowerCase() === parsed.name) matches.push({ value: entry.value, scope });
    }
  }
  return matches;
};
