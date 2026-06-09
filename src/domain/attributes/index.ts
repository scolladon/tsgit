export type { AttributeValue } from './attribute-value.js';
export {
  type DriverPlaceholders,
  substituteDriverPlaceholders,
} from './driver-command.js';
export {
  BUILTIN_MACROS,
  buildMacroRegistry,
  expandAttributes,
  type MacroRegistry,
} from './macros.js';
export {
  type AttributeRule,
  type MacroDef,
  type ParsedAttributes,
  parseGitattributes,
} from './parse-gitattributes.js';
export { type AttributeSource, resolveAttribute } from './resolve-attribute.js';
