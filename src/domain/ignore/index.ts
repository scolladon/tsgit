export { type MatchResult, matches } from './match.js';
export { type IgnoreLevel, matchInStack } from './matcher-stack.js';
export {
  type IgnoreRule,
  type IgnoreRuleset,
  parseGitignore,
  type TokenizedIgnoreLine,
  tokenizeIgnoreLine,
} from './parse-gitignore.js';
