import type { AttributeValue } from './attribute-value.js';
import { expandAttributes, type MacroRegistry } from './macros.js';
import type { AttributeRule } from './parse-gitattributes.js';

/**
 * One attributes file's rules, tagged with the directory it lives in. Patterns
 * are matched against a path made relative to `basedir` (`''` is the repo root).
 */
export interface AttributeSource {
  readonly basedir: string;
  readonly rules: ReadonlyArray<AttributeRule>;
}

/** The path relative to `basedir`, or `undefined` when it is not under it. */
const relativeTo = (path: string, basedir: string): string | undefined => {
  if (basedir === '') return path;
  const prefix = `${basedir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
};

/** The last-matching rule's value for `name` within one source, after macro expansion. */
const resolveInSource = (
  source: AttributeSource,
  path: string,
  name: string,
  macros: MacroRegistry,
): AttributeValue | undefined => {
  const rel = relativeTo(path, source.basedir);
  if (rel === undefined) return undefined;
  let found: AttributeValue | undefined;
  for (const rule of source.rules) {
    if (!rule.compiled.test(rel)) continue;
    const value = expandAttributes(rule.attributes, macros).get(name);
    if (value !== undefined) found = value;
  }
  return found;
};

/**
 * Resolve `name` for `path` over precedence-ordered `sources` (highest first).
 * Within a source the last matching rule wins; across sources the first that
 * assigns the attribute wins. Yields `'unspecified'` when none assign it.
 */
export const resolveAttribute = (
  sources: ReadonlyArray<AttributeSource>,
  path: string,
  name: string,
  macros: MacroRegistry,
): AttributeValue => {
  for (const source of sources) {
    const value = resolveInSource(source, path, name, macros);
    if (value !== undefined) return value;
  }
  return 'unspecified';
};
