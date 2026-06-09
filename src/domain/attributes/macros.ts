import type { AttributeValue } from './attribute-value.js';
import type { MacroDef } from './parse-gitattributes.js';

/** A macro name → the attributes it expands to. */
export type MacroRegistry = ReadonlyMap<string, ReadonlyMap<string, AttributeValue>>;

/** Git's sole built-in macro: `[attr]binary -diff -merge -text`. */
export const BUILTIN_MACROS: MacroRegistry = new Map<string, ReadonlyMap<string, AttributeValue>>([
  [
    'binary',
    new Map<string, AttributeValue>([
      ['diff', false],
      ['merge', false],
      ['text', false],
    ]),
  ],
]);

/**
 * Expand a rule's attribute map (insertion order = token order) through macros:
 * when a token sets a macro name (`name` is a macro and its value is `true`),
 * the macro's attributes are applied at that token's position. A later explicit
 * token therefore overrides a macro-derived value, and vice versa.
 */
export const expandAttributes = (
  attributes: ReadonlyMap<string, AttributeValue>,
  macros: MacroRegistry,
): Map<string, AttributeValue> => {
  const effective = new Map<string, AttributeValue>();
  for (const [name, value] of attributes) {
    const macro = value === true ? macros.get(name) : undefined;
    effective.set(name, value);
    if (macro !== undefined) {
      for (const [macroName, macroValue] of macro) effective.set(macroName, macroValue);
    }
  }
  return effective;
};

/** Merge user `[attr]` macro definitions over the built-ins (user definitions win). */
export const buildMacroRegistry = (
  defs: ReadonlyArray<MacroDef>,
  base: MacroRegistry = BUILTIN_MACROS,
): MacroRegistry => {
  const registry = new Map<string, ReadonlyMap<string, AttributeValue>>(base);
  for (const def of defs) registry.set(def.name, def.attributes);
  return registry;
};
